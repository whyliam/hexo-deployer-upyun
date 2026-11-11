'use strict';

const UpYun = require('upyun');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const isUploadResult = require('./lib/upload-result');

function md5(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

function getIgnoreRegExp(args, type) {
  const pattern = args.ignore_path_re && args.ignore_path_re[type];
  return pattern ? new RegExp(pattern) : /a^/;
}

async function withRetry(fn, retries, log) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      const delay = Math.min(1000 * Math.pow(2, i), 10000);
      log.warn(`Retry ${i + 1}/${retries} after ${delay}ms: ${err.message || err}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function runConcurrent(tasks, concurrency, onProgress) {
  let completed = 0;
  let failed = 0;
  const failures = [];
  const total = tasks.length;

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map(t => t()));
    for (const r of results) {
      if (r.status === 'fulfilled') completed++;
      else {
        failed++;
        failures.push(r.reason);
      }
    }
    if (onProgress) onProgress(completed, failed, total);
  }
  return { completed, failed, failures };
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

hexo.extend.deployer.register('upyun', async function (args) {
  const log = this.log || hexo.log;
  const public_dir = path.join(this.base_dir, this.config.public_dir);
  const concurrency = parseInt(args.concurrency) || 10;
  const retries = parseInt(args.try_times) || 3;
  const force = args.force || process.env.UPYUN_FORCE === '1';

  // 1. Validate config & init client
  const upyun_operator = process.env.UPYUN_OPERATOR || args.operator;
  const upyun_password = process.env.UPYUN_PASSWORD || args.password;

  if (!args.bucket || !upyun_operator || !upyun_password) {
    log.error('Missing UPYUN config. Please set bucket, operator and password.');
    return;
  }

  const service = new UpYun.Service(args.bucket, upyun_operator, upyun_password);
  const client = new UpYun.Client(service);

  // 2. Fetch remote .file_list.json (fault-tolerant)
  let remoteList = [];
  if (!force) {
    try {
      const data = await client.getFile('.file_list.json', null);
      if (data === false) {
        log.info('No remote .file_list.json found, will do full upload.');
      } else if (data != null) {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          try {
            remoteList = JSON.parse(data);
          } catch (e) {
            log.warn('.file_list.json is corrupted, falling back to full upload.');
            remoteList = [];
          }
        } else if (Array.isArray(data)) {
          remoteList = data;
        } else {
          log.warn('Unexpected response from getFile, falling back to full upload.');
          remoteList = [];
        }
      }
    } catch (err) {
      log.warn(`Failed to fetch remote .file_list.json: ${err.message || err}, falling back to full upload.`);
      remoteList = [];
    }
  } else {
    log.info('Force mode enabled, skipping incremental diff.');
  }

  // 3. Scan local public directory & compute MD5
  const ignoreFileRE = getIgnoreRegExp(args, 'file');
  const ignoreDirRE = getIgnoreRegExp(args, 'dir');

  async function getLocalList(dir) {
    const entries = await fs.readdir(dir);
    const res = [];

    for (const name of entries) {
      const fullPath = path.join(dir, name);
      const stats = await fs.stat(fullPath);

      if (stats.isFile()) {
        if (ignoreFileRE.test(fullPath)) continue;
        const content = await fs.readFile(fullPath);
        res.push({ name, type: 'file', md5sum: md5(content) });
      } else if (stats.isDirectory()) {
        if (ignoreDirRE.test(fullPath)) continue;
        const subItems = await getLocalList(fullPath);
        res.push({ name, type: 'dir', subItems });
      }
    }

    return res;
  }

  const localList = await getLocalList(public_dir);

  // 4. Compute diff (or skip in force mode)
  function getDiffList(remoteList, localList) {
    let removeList = [];
    let putList = [];
    let removeDirList = [];
    let mkdirList = [];

    const remoteFiles = remoteList.filter(x => x.type === 'file');
    const localFiles = localList.filter(x => x.type === 'file');

    for (const remote of remoteFiles) {
      const index = localFiles.findIndex(x => x.name === remote.name);
      const local = index === -1 ? null : localFiles[index];

      if (local) {
        localFiles.splice(index, 1);
        if (local.md5sum !== remote.md5sum) {
          putList.push(local.name);
        }
      } else {
        removeList.push(remote.name);
      }
    }

    if (localFiles.length) {
      putList = putList.concat(localFiles.map(x => x.name));
    }

    const remoteDirs = remoteList.filter(x => x.type === 'dir');
    const localDirs = localList.filter(x => x.type === 'dir');

    function concatSubItems(subLists, prefixPath) {
      function joinPrefix(list) {
        return list.map(x => path.join(prefixPath, x));
      }
      removeList = removeList.concat(joinPrefix(subLists.removeList));
      putList = putList.concat(joinPrefix(subLists.putList));
      removeDirList = removeDirList.concat(joinPrefix(subLists.removeDirList));
      mkdirList = mkdirList.concat(joinPrefix(subLists.mkdirList));
    }

    for (const remote of remoteDirs) {
      const index = localDirs.findIndex(x => x.name === remote.name);
      const local = index === -1 ? null : localDirs[index];

      if (local) {
        localDirs.splice(index, 1);
        const subLists = getDiffList(remote.subItems, local.subItems);
        concatSubItems(subLists, remote.name);
      } else {
        const subLists = getDiffList(remote.subItems, []);
        concatSubItems(subLists, remote.name);
        removeDirList.push(remote.name);
      }
    }

    if (localDirs.length) {
      for (const local of localDirs) {
        mkdirList.push(local.name);
        const subLists = getDiffList([], local.subItems);
        concatSubItems(subLists, local.name);
      }
    }

    function getDirDepth(dir) {
      return dir.split('/').length;
    }

    mkdirList.sort((a, b) => getDirDepth(a) - getDirDepth(b));
    removeDirList.sort((a, b) => getDirDepth(b) - getDirDepth(a));

    return { removeList, putList, removeDirList, mkdirList };
  }

  const lists = force
    ? { removeList: [], putList: [], removeDirList: [], mkdirList: [] }
    : getDiffList(remoteList, localList);

  // In force mode, build putList/mkdirList from localList recursively
  if (force) {
    function collectAll(items, prefix) {
      for (const item of items) {
        const p = prefix ? path.join(prefix, item.name) : item.name;
        if (item.type === 'file') {
          lists.putList.push(p);
        } else if (item.type === 'dir') {
          lists.mkdirList.push(p);
          collectAll(item.subItems, p);
        }
      }
    }
    collectAll(localList, '');
    lists.mkdirList.sort((a, b) => a.split('/').length - b.split('/').length);
  }

  // Count total operations for progress
  const totalOps = lists.removeList.length + lists.removeDirList.length
    + lists.mkdirList.length + lists.putList.length;

  if (totalOps === 0) {
    log.info('No changes detected. Deployment is up to date.');
    return;
  }

  log.info(`Deploying to UPYUN: ${lists.putList.length} uploads, ${lists.removeList.length} deletes, `
    + `${lists.mkdirList.length} mkdirs, ${lists.removeDirList.length} rmdirs, concurrency=${concurrency}`);

  let progressCount = 0;
  const allFailures = [];

  function makeProgressHandler(category) {
    return function onDone(completed, failed, total) {
      progressCount = progressCount; // batch-level tracking below
    };
  }

  // 5a. Delete files (concurrent with retry)
  if (lists.removeList.length > 0) {
    log.info(`Deleting ${lists.removeList.length} remote files...`);
    const tasks = lists.removeList.map(file => () =>
      withRetry(async () => {
        const data = await client.deleteFile(file);
        if (data !== true && data !== false) throw new Error(`deleteFile returned unexpected: ${data}`);
      }, retries, log).then(() => {
        progressCount++;
        if (progressCount % 100 === 0 || progressCount === totalOps) {
          log.info(`[${String(progressCount).padStart(4)}/${totalOps}] Deleted ${file}`);
        }
      }).catch(err => {
        progressCount++;
        allFailures.push({ action: 'delete', file, error: err.message || err });
        log.warn(`[${String(progressCount).padStart(4)}/${totalOps}] Failed to delete ${file}: ${err.message || err}`);
      })
    );
    await runConcurrent(tasks, concurrency, () => {});
  }

  // 5b. Delete empty directories (sequential-ish, deepest first, with retry)
  if (lists.removeDirList.length > 0) {
    log.info(`Deleting ${lists.removeDirList.length} remote directories...`);
    const tasks = lists.removeDirList.map(dir => () =>
      withRetry(async () => {
        const data = await client.deleteFile(dir);
        if (data !== true && data !== false) throw new Error(`deleteDir returned unexpected: ${data}`);
      }, retries, log).then(() => {
        progressCount++;
        if (progressCount % 100 === 0 || progressCount === totalOps) {
          log.info(`[${String(progressCount).padStart(4)}/${totalOps}] Removed dir ${dir}`);
        }
      }).catch(err => {
        progressCount++;
        allFailures.push({ action: 'rmdir', file: dir, error: err.message || err });
        log.warn(`[${String(progressCount).padStart(4)}/${totalOps}] Failed to remove dir ${dir}: ${err.message || err}`);
      })
    );
    await runConcurrent(tasks, concurrency, () => {});
  }

  // 5c. Create new directories (shallowest first, with retry)
  if (lists.mkdirList.length > 0) {
    log.info(`Creating ${lists.mkdirList.length} directories...`);
    const tasks = lists.mkdirList.map(dir => () =>
      withRetry(async () => {
        const data = await client.makeDir(dir);
        if (data !== true) throw new Error(`makeDir returned unexpected: ${data}`);
      }, retries, log).then(() => {
        progressCount++;
        if (progressCount % 100 === 0 || progressCount === totalOps) {
          log.info(`[${String(progressCount).padStart(4)}/${totalOps}] Created dir ${dir}`);
        }
      }).catch(err => {
        progressCount++;
        allFailures.push({ action: 'mkdir', file: dir, error: err.message || err });
        log.warn(`[${String(progressCount).padStart(4)}/${totalOps}] Failed to create dir ${dir}: ${err.message || err}`);
      })
    );
    await runConcurrent(tasks, concurrency, () => {});
  }

  // 5d. Upload files (concurrent with retry, progress per file)
  if (lists.putList.length > 0) {
    log.info(`Uploading ${lists.putList.length} files...`);
    const tasks = lists.putList.map(file => () =>
      withRetry(async () => {
        const filePath = path.resolve(public_dir, file);
        const fileContent = await fs.readFile(filePath);
        const data = await client.putFile(file, fileContent);
        if (!isUploadResult(data)) throw new Error('putFile returned an unsuccessful upload result');
        return fileContent.length;
      }, retries, log).then(size => {
        progressCount++;
        const sizeStr = humanSize(size);
        if (progressCount % 100 === 0 || progressCount === totalOps) {
          log.info(`[${String(progressCount).padStart(4)}/${totalOps}] Put ${file} (${sizeStr})`);
        }
      }).catch(err => {
        progressCount++;
        allFailures.push({ action: 'put', file, error: err.message || err });
        log.warn(`[${String(progressCount).padStart(4)}/${totalOps}] Failed to put ${file}: ${err.message || err}`);
      })
    );
    await runConcurrent(tasks, concurrency, () => {});
  }

  // 6. Summary
  const successCount = totalOps - allFailures.length;
  log.info(`Deployment summary: ${successCount}/${totalOps} operations succeeded.`);

  if (allFailures.length > 0) {
    log.warn(`${allFailures.length} operations failed:`);
    for (const f of allFailures) {
      log.warn(`  [${f.action}] ${f.file}: ${f.error}`);
    }

    // 7. If there are failures, skip updating .file_list.json
    const failRate = allFailures.length / totalOps;
    if (failRate > 0.1) {
      log.error(`Failure rate ${(failRate * 100).toFixed(1)}% exceeds 10% threshold. Deployment failed.`);
      throw new Error(`UPYUN deployment failed: ${allFailures.length}/${totalOps} operations failed.`);
    }

    log.warn(`Failure rate ${(failRate * 100).toFixed(1)}% is within tolerance. Skipping .file_list.json update.`);
    return;
  }

  // 7. Update remote .file_list.json (only if all operations succeeded)
  try {
    await withRetry(async () => {
      const data = await client.putFile('.file_list.json', Buffer.from(JSON.stringify(localList)));
      if (data !== true) throw new Error(`putFile returned unexpected: ${data}`);
    }, retries, log);
    log.info('Updated remote .file_list.json successfully.');
  } catch (err) {
    log.warn(`Failed to update .file_list.json: ${err.message || err}. Next deploy will re-upload all files.`);
  }
});

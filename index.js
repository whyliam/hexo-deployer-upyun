/*
 *  This file is part of hexo-deployer-upyun.
 *
 *  Copyright (c) 2016 Menci <huanghaorui301@gmail.com>
 *
 *  hexo-deployer-upyun is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  hexo-deployer-upyun is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with hexo-deployer-upyun. If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const UpYun = require('upyun');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

function md5(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

function color(code, text) {
  return `\u001b[${code}m${text}\u001b[39m`;
}

function green(text) {
  return color(32, text);
}

function yellow(text) {
  return color(33, text);
}

function magenta(text) {
  return color(35, text);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getIgnoreRegExp(args, type) {
  let pattern = args.ignore_path_re && args.ignore_path_re[type];
  return pattern ? new RegExp(pattern) : /a^/;
}

hexo.extend.deployer.register('upyun', async function (args) {
  try {
    let public_dir = path.join(this.base_dir, this.config.public_dir);
    let upyun_operator = process.env.UPYUN_OPERATOR || process.env.upyun_operator || args.operator;
    let upyun_password = process.env.UPYUN_PASSWORD || process.env.upyun_password || args.password;

    if (!args.bucket || !upyun_operator || !upyun_password) {
      console.log('Please check your config.');
      return;
    }

    let service = new UpYun.Service(args.bucket, upyun_operator, upyun_password);
    let client = new UpYun.Client(service);

    async function getRemoteList() {
      let data = await client.getFile('.file_list.json', null);
      if (data === false) {
        return [];
      } else if (data != undefined) {
        return data;
      } else throw data;
    }

    let remoteList = await getRemoteList();
    let ignoreFileRE = getIgnoreRegExp(args, 'file');
    let ignoreDirRE = getIgnoreRegExp(args, 'dir');

    async function getLocalList(dir) {
      let list = await readdir(dir);
      let res = [];

      for (let name of list) {
        let fillPath = path.join(dir, name);
        let stats = await stat(fillPath);

        if (stats.isFile()) {
          if (ignoreFileRE.test(fillPath)) continue;
          let content = await readFile(fillPath);
          let md5sum = md5(content);
          res.push({
            name: name,
            type: 'file',
            md5sum: md5sum
          });
        } else if (stats.isDirectory()) {
          if (ignoreDirRE.test(fillPath)) continue;
          let subItems = await getLocalList(fillPath);
          res.push({
            name: name,
            type: 'dir',
            subItems: subItems
          });
        }
      }

      return res;
    }

    let localList = await getLocalList(public_dir);

    function getDiffList(remoteList, localList) {
      let removeList = [];
      let putList = [];
      let removeDirList = [];
      let mkdirList = [];

      let remoteFiles = remoteList.filter(x => x.type === 'file');
      let localFiles = localList.filter(x => x.type === 'file');

      for (let remote of remoteFiles) {
        let index = localFiles.findIndex(x => x.name === remote.name);
        let local = index === -1 ? null : localFiles[index];

        if (local) {
          localFiles.splice(index, 1);

          if (local.md5sum === remote.md5sum) {
            continue;
          } else {
            putList.push(local.name);
          }
        } else {
          removeList.push(remote.name);
        }
      }

      if (localFiles.length) {
        putList = putList.concat(localFiles.map(x => x.name));
      }

      let remoteDirs = remoteList.filter(x => x.type === 'dir');
      let localDirs = localList.filter(x => x.type === 'dir');

      function concatSubItems(subLists, prefixPath) {
        function joinPrefixPath(list) {
          return list.map(x => path.join(prefixPath, x));
        }

        removeList = removeList.concat(joinPrefixPath(subLists.removeList));
        putList = putList.concat(joinPrefixPath(subLists.putList));
        removeDirList = removeDirList.concat(joinPrefixPath(subLists.removeDirList));
        mkdirList = mkdirList.concat(joinPrefixPath(subLists.mkdirList));
      }

      for (let remote of remoteDirs) {
        let index = localDirs.findIndex(x => x.name === remote.name);
        let local = index === -1 ? null : localDirs[index];

        if (local) {
          localDirs.splice(index, 1);

          let subLists = getDiffList(remote.subItems, local.subItems);
          concatSubItems(subLists, remote.name);
        } else {
          let subLists = getDiffList(remote.subItems, []);
          concatSubItems(subLists, remote.name);
          removeDirList.push(remote.name);
        }
      }

      if (localDirs.length) {
        for (let local of localDirs) {
          mkdirList.push(local.name);
          let subLists = getDiffList([], local.subItems);
          concatSubItems(subLists, local.name);
        }
      }

      function getDirDepth(dir) {
        return dir.split('/').length;
      }

      mkdirList.sort((a, b) => getDirDepth(a) - getDirDepth(b));
      removeDirList.sort((a, b) => getDirDepth(b) - getDirDepth(a));
      return {
        removeList: removeList,
        putList: putList,
        removeDirList: removeDirList,
        mkdirList: mkdirList
      };
    }

    let lists = getDiffList(remoteList, localList);

    async function processRemove(removeList) {
      for (let file of removeList) {
        let data = await client.deleteFile(file);

        if (data == true) {
          console.log(green('INFO ') + ` Removed file ${magenta(file)} successfully`);
        } else if (data == false) {
          console.log(yellow('WARN ') + ` Error removing file ${magenta(file)} - 404`);
        } else throw ['processRemove', file, data];
      }
    }

    async function processRemoveDir(removeDirList) {
      // Sometimes the remote API reports "directory not empty" immediately
      // after deleting child files, so retry before surfacing a fatal error.
      for (let dir of removeDirList) {
        let try_times = parseInt(args.try_times) || 5;
        let success = false;
        let data;

        while (try_times--) {
          data = await client.deleteFile(dir);

          if (data == true) {
            console.log(green('INFO ') + ` Removed dir ${magenta(dir)} successfully`);
            success = true;
            break;
          } else if (data == false) {
            console.log(yellow('WARN ') + ` Error removing dir ${magenta(dir)} - 404`);
            success = true;
            break;
          }

          await sleep(500);
        }

        if (!success) throw ['processRemoveDir', dir, data];
      }
    }

    async function processMkdir(mkdirList) {
      for (let dir of mkdirList) {
        let data = await client.makeDir(dir);

        if (data == true) {
          console.log(green('INFO ') + ` Make dir ${magenta(dir)} successfully`);
        } else throw ['processMkdir', dir, data];
      }
    }

    async function processPut(putList) {
      for (let file of putList) {
        let fileContent = await readFile(path.resolve(public_dir, file));
        let data = await client.putFile(file, fileContent);

        if (data == true) {
          console.log(green('INFO ') + ` Put file ${magenta(file)} successfully`);
        } else throw ['processPut', file, data];
      }
    }

    async function putFileList(fileList) {
      let data = await client.putFile('.file_list.json', Buffer.from(JSON.stringify(fileList)));

      if (data == true) {
        console.log(green('INFO ') + ' Put new file list successfully');
      } else throw ['putFileList', data];
    }

    await processRemove(lists.removeList);
    await processRemoveDir(lists.removeDirList);
    await processMkdir(lists.mkdirList);
    await processPut(lists.putList);
    await putFileList(localList);
  } catch (err) {
    console.log(err);
    throw err;
  }
});

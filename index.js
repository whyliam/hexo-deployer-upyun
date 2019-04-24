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


const Promise = require('bluebird');
const Upyun = require('upyun');
const fs = require('fs');

Promise.promisifyAll(fs);
const path = require('path');
const md5 = require('md5');
require('colors');

hexo.extend.deployer.register('upyun', async function (args) {
  try {
    const public_dir = path.join(this.base_dir, this.config.public_dir);

    const upyun_operator = process.env.upyun_operator || args.operator;
    const upyun_password = process.env.upyun_password || args.password;

    if (!args.bucket || !upyun_operator || !upyun_password) {
      console.log('Please check your config.');
      return;
    }

    const service = new Upyun.Service(args.bucket, upyun_operator, upyun_password);
    const client = new Upyun.Client(service);

    Promise.promisifyAll(client);

    // Get remote file list
    async function getRemoteList() {
      const data = await client.getFile('.file_list.json');
      if (data != undefined) {
        return data;
      }
      throw data;
    }

    const remoteList = await getRemoteList();

    const ignoreFileRE = new RegExp(args.ignore_path_re.file);
    const ignoreDirRE = new RegExp(args.ignore_path_re.dir);
    // Get local file list
    async function getLocalList(dir) {
      const list = await fs.readdirAsync(dir);
      const res = [];
      for (const name of list) {
        const fillPath = path.join(dir, name);
        const stats = await fs.statAsync(fillPath);
        if (stats.isFile()) {
          if (ignoreFileRE.test(fillPath)) continue;
          const content = await fs.readFileAsync(fillPath);
          const md5sum = md5(content);
          res.push({
            name,
            type: 'file',
            md5sum,
          });
        } else if (stats.isDirectory()) {
          if (ignoreDirRE.test(fillPath)) continue;
          const subItems = await getLocalList(fillPath);
          res.push({
            name,
            type: 'dir',
            subItems,
          });
        }
      }
      return res;
    }

    const localList = await getLocalList(public_dir);

    // Get diff list
    function getDiffList(remoteList, localList) {
      let removeList = [];
      let putList = [];
      let removeDirList = [];
      let mkdirList = [];

      // Determine which files to remote and put
      const remoteFiles = remoteList.filter(x => x.type === 'file');
      const localFiles = localList.filter(x => x.type === 'file');

      for (const remote of remoteFiles) {
        // For a remote file, find it in local files
        const index = localFiles.findIndex(x => x.name === remote.name);
        const local = index === -1 ? null : localFiles[index];

        if (local) {
          localFiles.splice(index, 1);
          if (local.md5sum === remote.md5sum) {
            // Not modified
            continue;
          } else {
            putList.push(local.name);
          }
        } else {
          removeList.push(remote.name);
        }
      }

      // The local files that wasn't matched by a remote file should be put
      if (localFiles.length) {
        putList = putList.concat(localFiles.map(x => x.name));
      }

      // Determine what dirs to remote or make
      const remoteDirs = remoteList.filter(x => x.type === 'dir');
      const localDirs = localList.filter(x => x.type === 'dir');

      function concatSubItems(subLists, prefixPath) {
        function joinPrefixPath(list) {
          return list.map(x => path.join(prefixPath, x));
        }
        removeList = removeList.concat(joinPrefixPath(subLists.removeList));
        putList = putList.concat(joinPrefixPath(subLists.putList));
        removeDirList = removeDirList.concat(joinPrefixPath(subLists.removeDirList));
        mkdirList = mkdirList.concat(joinPrefixPath(subLists.mkdirList));
      }

      for (const remote of remoteDirs) {
        // For a remote dir, find it in local dirs
        const index = localDirs.findIndex(x => x.name === remote.name);
        const local = index === -1 ? null : localDirs[index];

        if (local) {
          localDirs.splice(index, 1);
          // Get diff of files and dirs in the dir
          const subLists = getDiffList(remote.subItems, local.subItems);
          concatSubItems(subLists, remote.name);
        } else {
          // Get diff of files and dirs in the dir
          const subLists = getDiffList(remote.subItems, []);
          concatSubItems(subLists, remote.name);
          removeDirList.push(remote.name);
        }
      }

      // The local dirs that wasn't matched by a remote dir should be make and put
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

      return {
        removeList,
        putList,
        removeDirList,
        mkdirList,
      };
    }

    const lists = getDiffList(remoteList, localList);

    // Process the lists
    async function processRemove(removeList) {
      for (const file of removeList) {
        let data = await client.deleteFile(file);
        if (data = true) {
          console.log(`${'INFO '.green} Removed file ${file.magenta} successfully`);
        } else if (data = false) {
          console.log(`${'WARN '.yellow} Error removing file ${file.magenta} - 404`);
        } else throw ['processRemove', file, data];
      }
    }

    async function processRemoveDir(removeDirList) {
      // Sometimes if we remove a dir just after removing the inside files,
      // we got 'directory not empty', so let's try 5 times before throw an
      // fatel error.
      for (const dir of removeDirList) {
        let try_times = parseInt(args.try_times) || 5;
        let success = false;
        while (try_times--) {
          const data = await client.deleteFile(dir);
          if (data == true) {
            console.log(`${'INFO '.green} Removed dir ${dir.magenta} successfully`);
            success = true;
            break;
          } else if (data == false) {
            console.log(`${'WARN '.yellow} Error removing dir ${dir.magenta} - 404`);
            success = true;
            break;
          }
          await Promise.delay(500);
        }
        if (!success) throw ['processRemoveDir', dir, data];
      }
    }

    async function processMkdir(mkdirList) {
      for (const dir of mkdirList) {
        const data = await client.makeDir(dir);
        if (data == true) {
          console.log(`${'INFO '.green} Make dir ${dir.magenta} successfully`);
        } else throw ['processMkdir', dir, data];
      }
    }

    async function processPut(putList) {
      for (const file of putList) {
        let mimeType = null;
        if (path.extname(file) === '') mimeType = 'text/html';

        const fileContent = await fs.readFileAsync(path.resolve(public_dir, file));

        const data = await client.putFile(file, fileContent);
        if (data == true) {
          console.log(`${'INFO '.green} Put file ${file.magenta} successfully`);
        } else throw ['processPut', file, data];
      }
    }

    async function putFileList(fileList) {
      const data = await client.putFile('.file_list.json', Buffer.from(JSON.stringify(fileList)));
      if (data == true) {
        console.log(`${'INFO '.green} Put new file list successfully`);
      } else throw ['putFileList', data];
    }

    await processRemove(lists.removeList);
    await processRemoveDir(lists.removeDirList);
    await processMkdir(lists.mkdirList);
    await processPut(lists.putList);
    await putFileList(localList);
  } catch (e) {
    console.log(`${'ERROR'.red} The error message is below`);
    console.log(e);
  }
});

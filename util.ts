// Stuff that should have already existed in JavaScript, but doesn't
import * as fs from 'fs';
import * as path from 'path';
import {spawnSync, SpawnSyncOptions} from 'child_process';

/**
 * Creates a folder and if necessary, parent folders also. Returns true
 * if any folders were created. Understands both '/' and path.sep as 
 * path separators. Doesn't try to create folders that already exist,
 * which could cause a permissions error. Gracefully handles the race 
 * condition if two processes are creating a folder. Throws on error.
 * @param targetDir Name of folder to create
 */
export function mkdirSyncRecursive(targetDir: string) {
  if (!fs.existsSync(targetDir)) {
    for (var i = targetDir.length-2; i >= 0; i--) {
      if (targetDir.charAt(i) == '/' || targetDir.charAt(i) == path.sep) {
        mkdirSyncRecursive(targetDir.slice(0, i));
        break;
      }
    }
    try {
      fs.mkdirSync(targetDir);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  return false;
}

export function escapeRegExp(str: string) { // From Mozilla
  return str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
}

export function replaceAll(str: string, find: string, replacement: string) {
  return str.replace(new RegExp(escapeRegExp(find), 'g'), replacement);
}

export function isPrimitive(x:any) {
  return x == null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number';
}

/** Run an external process synchronously and throws if error
 * Note 1: the arguments must be provided separately, e.g. instead
 *   of run("npm install"), use run("npm", ["install"]).
 * Note 2: I don't think this goes through a shell (e.g. bash) and
 *   IIRC on Linux, expansion of wildcards is done by the shell, not
 *   by the target program. So don't use wildcard arguments here.
 */
export function run(command: string, args: string[], options?: SpawnSyncOptions)
{
  // On Windows, {shell: true} is required for running batch files 
  // (shell scripts) and many Node.js tools are actually batch files.
  options = options || {cwd: '.', stdio: 'inherit', shell: true};
  var result = spawnSync(command, args, options);
  if (result.signal) throw `${command} signal: ${result.signal}`;
  if (result.status) throw `${command} exited with code ${result.status}`;
  return result; // Note: result.stdout==null when {stdio:'inherit'}
}

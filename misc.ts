// Stuff that should have already existed in JavaScript, but doesn't
// Sad fact: this WAS called util.ts but import from './util' didn't work
//           in ts-node, although it worked properly when compiled with tsc.
import * as fs from 'fs';
import * as path from 'path';
import {spawnSync, SpawnSyncOptions} from 'child_process';

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

// Array.prototype.flat is not yet available
export function flatten(array: any[]): any[] {
  const stack = [...array];
  const result = [];
  while (stack.length) {
    const next = stack.pop();
    if (Array.isArray(next))
      stack.push(...next);
    else
      result.push(next);
  }
  return result.reverse();
}

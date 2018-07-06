#!/usr/bin/env node
var fs = require('fs');
var tar = require('tar');
const { spawnSync } = require('child_process');

interface Options {
  "package.json-replace"?: any; // --package.json={...}
  "package.json"?: any;         // --package.json=+{...}
  "package.json-file": string;
  "replace-import"?: [string, string];
  "regex"?: { exts:string[], regex:string, regexOptions:string };
  "install"?: [string];
  "keep"?: [string];
  "test-folder"?: string;
  "rmdir"?: boolean;
  "test-script"?: string;
  "prepacked"?: string;
}

/** Converts args to the Options interface and performs type checking */
export function refineArgs(args: any): Options {
  var k: string;
  expect(args[k = 'package.json-replace'] === undefined ||
         args[k] instanceof Object, `${k} should be an object`);
  if (!(args[k = 'package.json'] instanceof Object)) {
    if (maybeUpgradeToArrayOfString(args, k, false)) {
      var mergings = {}, replaces = {};
      for (let s of args[k] as string[]) {
        if (s.charAt(0) === '+')
          mergings = Object.assign(mergings, evalToObject(s.slice(1)));
        else
          replaces = Object.assign(replaces, evalToObject(s));
      }
      args['package.json'] = mergings;
      args['package.json-replace'] = replaces;
    }
  }
  expectType(args, 'package.json-file', 'string');
  if (args[k = 'replace-import'] !== undefined) {
    if (typeof args[k] === 'string')
      args[k] = splitInTwo(args[k], '=');
    expectArrayOf(args, k, 'string', 2);
  }
  if (args[k = 'regex'] !== undefined) {
    if (typeof args[k] === 'string') {
      var regex = args[k] as string;
      var i = 0, c;
      while((c = regex.charAt(i)) >= 'a' && c <= 'z' || 
            c >= 'A' && c <= 'Z' || c == ',')
            i++;
      var exts = regex.slice(0, i).split(',');
      var end_i = regex.lastIndexOf(regex.charAt(i), i+1);
      expect(i < regex.length - 1 && end_i > i, "syntax error in regex option");
      var regexOptions = regex.slice(end_i + 1);
      args[k] = { exts, regex: regex.slice(i+1, end_i), regexOptions };
    }
    expect('exts' in args[k] && 'regex' in args[k], 
      'regex option should contain "exts" and "regex" subkeys');
    expectArrayOf(args[k], 'exts', 'string');
    expectType(args[k], 'regex', 'string');
    expectType(args[k], 'regexOptions', 'string');
  }
  maybeUpgradeToArrayOfString(args, 'install', true);
  maybeUpgradeToArrayOfString(args, 'keep', true);
  expectType(args, 'test-folder', 'string');
  expectType(args, 'rmdir', 'boolean');
  expectType(args, 'test-script', 'string');
  expectType(args, 'prepacked', 'string');
  
  return args as Options;

  function expect(test: boolean, err: string) {
    if (!test) throw err;
  }
  function expectType(args: any, k: string, type: string) {
    if (args[k] !== undefined) {
      expect(args[k] !== null && typeof args[k] === type,
        `${k} should be a ${type}`);
    }
  }
  function expectArrayOf(args: any, k: string, type: string, length?: number) {
    if (args[k] !== undefined) {
      expect(Array.isArray(args[k]) && !args[k].some((v:any) => typeof v !== type), 
        `${k} should be an array of ${type}`);
      expect(length === undefined || args[k].length === length,
        `${k} should have ${length} elements`);
    }
  }
  function maybeUpgradeToArrayOfString(args: any, k: string, commaSeparated: boolean) {
    if (args[k] !== undefined) {
      if (typeof args[k] === 'string')
        args[k] = [args[k]];
      expectArrayOf(args, k, 'string');
      if (commaSeparated)
        args[k] = args[k].map((s: string) => s.split(',')).flat(1);
      return true;
    }
    return false;
  }
  function splitInTwo(s:string, delim:string) {
    let i = s.indexOf(delim);
    return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + delim.length)];
  }
}

export function packAndVerify(args: Options, pkgJson: Object) {
  var pkg = computeNewPackageJson(args["package.json-file"] || "package.json", args);
  runNpmPack(args);
}

function mkdirSync(dirPath) {
  try {
    fs.mkdirSync(dirPath)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

/** Run an external process synchronously and throws if error
 * Note 1: the arguments must be provided separately, e.g. instead
 *   of run("npm install"), use run("npm", ["install"]).
 * Note 2: I don't think this goes through a shell (e.g. bash) and
 *   IIRC on Linux, expansion of wildcards is done by the shell, not
 *   by the target program. So don't use wildcard arguments here.
 */
function run(command, args, options)
{
  // On Windows, {shell: true} is required for running batch files 
  // (shell scripts) and many Node.js tools are actually batch files.
  options = options || {cwd: '.', stdio: 'inherit', shell: true};
  var result = spawnSync(command, args, options);
  if (result.signal) throw `${command} signal: ${result.signal}`;
  if (result.status) throw `${command} exited with code ${result.status}`;
  return result; // Note: result.stdout==null when {stdio:'inherit'}
}

function evalToObject(data: string) {
  if (data.charAt(0) !== '{')
    data = "{"+data+"}";
  // Shouldn't be too dangerous: we expect to be run from a shell
  // or by a script in package.json, and commands in those places
  // can probably run arbitrary code already.
  return eval(data);
}

function merge(oldVal, newVal) {
  // If the new value is a primitive, it overwrites the old value.
  // If the old value is a primitive, it is treated as an array.
  // If both are arrays, they are concatenated.
  // If either one is an object, they are merged in the obvious way.
  if (isPrimitive(newVal))
    return newVal;
  if (isPrimitive(oldVal))
    oldVal = [oldVal];
  // Neither is a primitive, so each one is an array or object.
  if (Array.isArray(oldVal) && Array.isArray(newVal))
    return oldVal.concat(newVal);
  return mergeObjects(oldVal, newVal);
}
function mergeObjects(oldVal, newVal) {
  var obj = Object.assign({}, oldVal);
  for (let key in Object.keys(newVal)) {
    if (newVal[key] === undefined)
      delete obj[key];
    else if (obj[key] === undefined)
      obj[key] = newVal[key];
    else
      obj[key] = merge(obj[key], newVal[key]);
  }
}

function computeNewPackageJson(filename, args) {
  var packageText = fs.readFileSync(filename, 'utf8');
  var pkg = JSON.parse(packageText);
  args = pkg.packverify = Object.assign(pkg.packverify || {}, args);

  var edits = args['package.json'];
  if (edits !== undefined) {
    if (edits instanceof String) {
      if (edits.charAt(0)==='+') {
        merge(pkg, evalToObject(edits.slice(1)))
      } else {
        var obj = evalToObject(edits);
        Object.keys(edits).forEach(key => pkg[key] = edits[key]);
      }
    } else
      merge(pkg, edits);
  }
}
function runNpmPack(args) {
  var pkgName = args.prepacked || args['tgz-name'] || `${pkg['name']}-${pkg['version']}.tgz`;
  if (args.prepacked == undefined) {
    var error = run("npm", ["pack"]).status;
    if (error) throw `npm pack failed (code ${error})`;
  }
  if (!fs.existsSync(pkgName))
    throw `Expected package file ${pkgName} does not exist.`;
}

#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import {isPrimitive, mkdirSyncRecursive, run} from './util';
import * as _ from 'underscore';

type PackageJson = {
  "name": string;
  "version": string;
  "dependencies"?: any;
  "devDependencies"?: any;
  "scripts"?: any;
  "testpack"?: any;
};

interface Options {
  "package.json-replace"?: any; // --package.json={...}
  "package.json"?: any;         // --package.json=+{...}
  "package.json-file"?: string; // file to load (generated file is always package.json)
  "replace-import"?: string[];
  "regex"?: { exts:string[], regex:string, regexOptions:string };
  "install"?: string[];
  "keep"?: string[];
  "test-folder"?: string;
  "rmdir"?: boolean;
  "test-script"?: string;
  "prepacked"?: string;
}

/**
 * Implements the testpack command-line tool.
 * @param opts Options
 */
export function testPack(opts: Options) {
  var pkg = readPackageJson(opts);
  opts = combineOptions(pkg, opts);
  console.log(`========== testpack: running npm pack`);
  var tgzName = runNpmPack(pkg, opts);
  
  var testFolder = opts["test-folder"] || '.packtest';
  console.log(`========== testpack: preparing test folder: ${testFolder}`);
  transformPackageJson(pkg, opts);
  var isNew = mkdirSyncRecursive(testFolder);
  var newJson = JSON.stringify(pkg, undefined, 2);
  fs.writeFileSync(path.join(testFolder, "package.json"), newJson, 'utf8');
  
  process.chdir(testFolder);
  run("npm", ["install"]);
  for (let pkgName of opts.install || [])
    run("npm", ["install", "--save-dev", pkgName]);
  var tgzName2 = path.relative(testFolder, tgzName);
  run("npm", ["install", tgzName2]);

  // 6. Copies test files (test*,*test.*,*tests.*,*test*/*) to the folder,
  //    preserving the original directory structure.
  // 7. Changes import/require commands in the tests according to --replace
  // 8. Runs \`npm run test\` (or another script according to \`--test-script\`)
  // 9. Deletes node_modules in the test folder to avoid biasing future results
}

/** Converts args (produced by minimist or read from package.json)
 *  to the Options interface and performs type checking. */
export function refineOptions(args: any): Options {
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
    maybeUpgradeToArrayOfString(args, k, false);
    expect((args[k] as string[]).every(v => v.indexOf('=') > -1), 
      "Syntax error in replace-import: expected `=`");
  }
  if (args[k = 'regex'] !== undefined) {
    console.log('line 88');
    if (typeof args[k] === 'string') {
      var regex = args[k] as string;
      var i = 0, c;
      while((c = regex.charAt(i)) >= 'a' && c <= 'z' || 
            c >= 'A' && c <= 'Z' || c == ',')
            i++;
      var exts = regex.slice(0, i).split(',');
      var end_i = regex.lastIndexOf(regex.charAt(i));
      expect(i < regex.length - 1 && end_i > i, "syntax error in regex option");
      args[k] = { exts, regex: regex.slice(i+1, end_i) };
      var regexOptions = regex.slice(end_i + 1);
      if (regexOptions.length > 0)
        args[k].regexOptions = regexOptions;
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
  function expectArrayOf(args: any, k: string, type: string) {
    if (args[k] !== undefined) {
      expect(Array.isArray(args[k]) && args[k].every((v:any) => typeof v === type), 
        `${k} should be an array of ${type}`);
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

export function readPackageJson(opts: Options): PackageJson {
  var packageJson = opts["package.json-file"] || "package.json";
  // If package.json not found, try parent folders
  while (!fs.existsSync(packageJson)) {
    try {
      // Use chdir because all other files are relative to package.json
      process.chdir('..');
    } catch {
      break;
    }
  }
  try {
    var packageText = fs.readFileSync(packageJson, 'utf8');
    return JSON.parse(packageText) as PackageJson;
  } catch(e) {
    throw `Error reading ${packageJson}: ${e}`;
  }
}

function combineOptions(pkg: PackageJson, opts: Options): Options {
  if (!pkg.testpack)
    return opts;
  var pkgArgs: Options = refineOptions(Object.assign({}, pkg.testpack));
  return Object.assign(pkgArgs, opts);
}

function transformPackageJson(pkg: PackageJson, opts: Options)
{
  pkg.testpack = opts;

  var edits = opts['package.json'];
  if (edits !== undefined) {
    if (typeof edits === 'string') {
      if (edits.charAt(0)==='+') {
        merge(pkg, evalToObject(edits.slice(1)))
      } else {
        var obj = evalToObject(edits);
        for (let key of Object.keys(obj))
          (pkg as any)[key] = obj[key];
      }
    } else
      merge(pkg, edits);
  }

  // Delete all dependencies except popular unit test frameworks
  // and packages that the user whitelisted.
  var whitelist = ["mocha", "jasmine", "jest", "enzyme", "tape", "ava"];
  if (opts.keep) whitelist = whitelist.concat(opts.keep);
  if (pkg.dependencies)
    pkg.dependencies = _.pick(pkg.dependencies, whitelist);
  if (pkg.devDependencies)
    pkg.devDependencies = _.pick(pkg.devDependencies, whitelist);
}

function runNpmPack(pkg: PackageJson, opts: Options): string {
  var pkgName = opts.prepacked || `${pkg['name']}-${pkg['version']}.tgz`;
  if (opts.prepacked == undefined) {
    var error = run("npm", ["pack"]).status;
    if (error) throw `npm pack failed (code ${error})`;
  }
  if (!fs.existsSync(pkgName))
    throw `Expected npm pack to make ${pkgName} but it doesn't exist.`;
  return pkgName;
}

function evalToObject(data: string) {
  if (data.charAt(0) !== '{')
    data = "{"+data+"}";
  // Shouldn't be too dangerous: we expect to be run from a shell
  // or by a script in package.json, and commands in those places
  // can probably run arbitrary code already.
  return eval(data);
}

export function merge(oldVal: any, newVal: any) {
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
export function mergeObjects(oldVal:any, newVal:any) {
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


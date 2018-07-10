#!/usr/bin/env node
import * as fs from 'fs';
import * as fsextra from 'fs-extra';
import * as path from 'path';
import * as process from 'process';
import {isPrimitive, run} from './util';
import * as _ from 'underscore';
import * as glob from 'glob';
import * as globmatch from 'minimatch';

type PackageJson = {
  "name": string;
  "version": string;
  "dependencies"?: any;
  "devDependencies"?: any;
  "scripts"?: any;
  "testpack"?: any;
};
type ImportMatcher = { exts:string[], regex:string|RegExp, regexOptions?:string };

interface Options {
  "test-files": string[]; // glob patterns
  "ignore"?: string[]; // files not to be treated as tests
  "packagejson-replace"?: any; // --package.json={...}
  "packagejson"?: any;         // --package.json=+{...}
  "packagejson-file"?: string; // file to load (generated file is always package.json)
  "replace-import"?: string[]; // /pat1/pat2/
  "regex"?: ImportMatcher[];
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
  
  var testFolder = opts["test-folder"] = opts["test-folder"] || '.packtest';
  console.log(`========== testpack: preparing test folder: ${testFolder}`);
  transformPackageJson(pkg, opts);
  fsextra.ensureDirSync(testFolder);
  var newJson = JSON.stringify(pkg, undefined, 2);
  fs.writeFileSync(path.join(testFolder, "package.json"), newJson, 'utf8');
  
  var originalDir = path.relative(testFolder, '.');
  process.chdir(testFolder);
  run("npm", ["install"]);
  for (let pkgName of opts.install || [])
    run("npm", ["install", "--save-dev", pkgName]);
  var tgzName2 = path.relative(testFolder, tgzName);
  run("npm", ["install", tgzName2]);

  var testFiles = getTestFiles(opts, originalDir)
  console.log(`========== testpack: copyediting ${0} test files in ${testFolder}`);
  copyFileTree(testFiles, originalDir, '.');
  transformAllImports(testFiles, opts);
  
  console.log(`========== testpack: running tests`);
  run("npm", ["run", opts["test-script"] || "test"]);
  
  process.chdir(originalDir);
  var dirToRemove = opts.rmdir ? testFolder : path.join(testFolder, 'node_modules');
  console.log(`========== testpack: deleting ${dirToRemove}`);
  fsextra.remove(dirToRemove);
}

function transformAllImports(testFiles: string[], opts: Options) {
  var replacements: [RegExp, string][] | undefined = undefined;
  if (opts["replace-import"]) {
    replacements = opts["replace-import"]!.map(v => {
      var delim = v[v.length - 1];
      var first = v.indexOf(delim);
      var middle = v.indexOf(delim, first + 1);
      return [new RegExp(v.slice(first + 1, middle)),
      v.slice(middle + 1, v.length - 1)] as [RegExp, string];
    });
  }
  for (var filename of testFiles) {
    var matchers = getMatchersFor(filename, opts);
    transformImports(filename, filename, matchers, opts["test-files"], replacements);
  }
}

/** Converts args (produced by minimist or read from package.json)
 *  to the Options interface and performs type checking. */
export function refineOptions(args: any): Options {
  var k: string;
  if (!args[k = 'test-files'] && args._)
    args[k] = args._;
  if (args[k = 'test-files'] == null || args[k].length === 0)
    args[k] = ["*test*/*", "test*", "*test.*", "*tests.*"];
  else
    maybeUpgradeToArrayOfString(args, k, false);
  maybeUpgradeToArrayOfString(args, 'ignore', false);

  expect(args[k = 'packagejson-replace'] === undefined ||
         args[k] instanceof Object, `${k} should be an object`);
  if (!(args[k = 'packagejson'] instanceof Object)) {
    if (maybeUpgradeToArrayOfString(args, k, false)) {
      var mergings = {}, replaces = {};
      for (let s of args[k] as string[]) {
        if (s.charAt(0) === '+')
          mergings = Object.assign(mergings, evalToObject(s.slice(1)));
        else
          replaces = Object.assign(replaces, evalToObject(s));
      }
      args['packagejson'] = mergings;
      args['packagejson-replace'] = replaces;
    }
  }
  expectType(args, 'packagejson-file', 'string');

  if (args[k = 'replace-import'] !== undefined) {
    maybeUpgradeToArrayOfString(args, k, false);
    expect((args[k] as string[]).every(v => v[0] === v[v.length-1] && v.indexOf(v[0], 1) < v.length-1), 
      "Syntax error in replace-import: expected three slashes/delimiters");
  }

  if (args[k = 'regex'] !== undefined) {
    if (typeof args[k] === 'string')
      args[k] = [args[k]];
    else
      expect(Array.isArray(args[k]), `${k} should be an array`);
    var regexes: any[] = args[k];
    for (var r = 0; r < regexes.length; r++) {
      var regex = regexes[r];
      if (typeof regex === 'string') {
        var i = 0, c;
        while((c = regex.charAt(i)) >= 'a' && c <= 'z' || 
              c >= 'A' && c <= 'Z' || c == ',')
              i++;
        var exts = regex.slice(0, i).split(',');
        var end_i = regex.lastIndexOf(regex.charAt(i));
        expect(i < regex.length - 1 && end_i > i, "syntax error in regex option");
        regexes[r] = { exts, regex: regex.slice(i+1, end_i) };
        if (end_i + 1 < regex.length)
          regexes[r].regexOptions = regex.slice(end_i + 1);
      }
      expect(regex.exts !== undefined && regex.regex !== undefined, 
        'regex option should contain "exts" and "regex" subkeys');
      expectArrayOf(regex, 'exts', 'string');
      expectType(regex, 'regex', 'string');
      expectType(regex, 'regexOptions', 'string');
    }
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
  var packageJson = opts["packagejson-file"] || "package.json";
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

  // Delete all dependencies except popular unit test frameworks
  // and packages that the user whitelisted.
  var whitelist = ["mocha", "jasmine", "jest", "qunit", "enzyme", "tape", "ava"];
  if (opts.keep)
    whitelist = whitelist.concat(opts.keep);
  pkg.dependencies = filterToWhitelist(pkg.dependencies, whitelist);
  pkg.devDependencies = filterToWhitelist(pkg.devDependencies, whitelist);
  function filterToWhitelist(deps: any, whitelist: string[]) {
    if (deps)
      deps = _.pick(deps, (v:any,key:any) => {
        return whitelist.some(v => globmatch(key, v));
      });
    return deps;
  }

  var edits = opts['packagejson'];
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

function getTestFiles(opts: Options, fromFolder?: string): string[] {
  // Combine all inclusion patterns into one string, as glob requires
  var includes = "{" + opts["test-files"].join(',') + "}";
  return glob.sync(includes, {cwd: fromFolder, ignore: opts.ignore});
}
function copyFileTree(files: string[], fromFolder: string, toFolder: string)
{
  for (var file of files) {
    var toFile = path.join(toFolder, file);
    fsextra.ensureDirSync(path.dirname(toFile));
    fs.copyFileSync(path.join(fromFolder, file), toFile);
  }
}

function transformImports(inputFile: string, outputFile: string, matchers: RegExp[], testPatterns: string[], replaceImports?: [RegExp,string][])
{
  var file = fs.readFileSync(inputFile, 'utf8');
  var lines = file.split('\n');
  var changed = false;
  for (var l = 0; l < lines.length; l++) {
    for (var m = 0; m < matchers.length; m++) {
      for (var i = 0; i < lines[l].length;) {
        var match = lines[l].slice(i).match(matchers[m]);
        if (match == null) break;
        var importFn = match[1];
        if (importFn !== undefined) {
          if (replaceImports === undefined) {
            // Default behavior: remove './' except if it appears to
            // import a test file, in which case do nothing.
            if (importFn.startsWith("./") || importFn.startsWith(".\\")) {
              if (!testPatterns.some(tp => globmatch(importFn, tp)))
                importFn = importFn.slice(2);
            }
          } else {
            // Obey custom replacement patterns
            replaceImports.forEach(([from, to]) => {
              importFn = importFn.replace(from, to);
            });
          }
          if (importFn !== match[1]) {
            // A replacement was made... insert it into the original line
            var iStart = i + match.index! + match[0].lastIndexOf(match[1]);
            var iEnd = iStart + match[1].length;
            lines[l] = lines[l].slice(0, iStart) + importFn + lines[l].slice(iEnd);
            changed = true;
            i = iEnd;
          }
        }
      }
    }
  }
  fs.writeFileSync(outputFile, lines.join('\n'), 'utf8');
}

var jsExts = ["js", "mjs", "ts", "tsx"];
export var defaultRegexes: ImportMatcher[] = [
  { exts: jsExts, regex: /require\s*\(\s*"((?:[^\\"]|\\.)*)"/ },
  { exts: jsExts, regex: /require\s*\(\s*'((?:[^\\']|\\.)*)'/ },
  { exts: jsExts, regex: /[a-zA-Z0-9_}]\s*from\s*"((?:[^\\"]|\\.)*)"/ },
  { exts: jsExts, regex: /[a-zA-Z0-9_}]\s*from\s*'((?:[^\\"]|\\.)*)'/ },
];
export function getMatchersFor(fileName: string, opts: Options): RegExp[]
{
  var ext = fileName.indexOf('.') > -1 ? path.extname(fileName) : fileName;
  var results: RegExp[] = [];
  for (var matcher of defaultRegexes.concat(opts.regex || [])) {
    if (matcher.exts.indexOf(ext) > -1) {
      if (matcher.regex instanceof RegExp)
        results.push(matcher.regex);
      else
        results.push(new RegExp(matcher.regex, matcher.regexOptions));
    }
  }
  return results;
}

/////////////////////////////////////////////////////////////////////////////
// Lower-level functions

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


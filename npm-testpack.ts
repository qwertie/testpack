#!/usr/bin/env node
import fs from 'fs';
import * as fsextra from 'fs-extra';
import * as path from 'path';
import * as process from 'process';
import * as glob from 'glob';
import * as _ from 'underscore';
import globmatch from 'minimatch';
import {isPrimitive, run, flatten} from './misc';

export type PackageJson = {
  "name"?: string;
  "version"?: string;
  "dependencies"?: any;
  "devDependencies"?: any;
  "scripts"?: any;
  "testpack"?: any;
};
export type ImportMatcher = { exts:string[], regex:string|RegExp, regexOptions?:string };

export interface Options {
  "test-files": string[];      // glob patterns
  "nontest"?: string[];        // files not to be treated as tests
  "packagejson-replace"?: any; // --package.json={...}
  "packagejson"?: any;         // --package.json=+{...}
  "packagejson-file"?: string; // file to load (generated file is always package.json)
  "replace-import"?: string[]; // each string has the form /pat1/pat2/ (delimiter can vary)
  "replace-test-imports"?: boolean; // normally false
  "regex"?: ImportMatcher[];
  "install"?: string[];
  "keep"?: string[];
  "test-folder"?: string;
  "rmdir"?: boolean;
  "test-script"?: string;
  "prepacked"?: string;
  "verbose"?: boolean;
}

function expect(test: boolean, err: string) {
  if (!test) throw err;
}

/**
 * Implements the testpack command-line tool.
 * @param opts Options
 */
export function testPack(opts: Options) {
  var pkg = readPackageJson(opts['packagejson-file']);
  opts = combineOptions(pkg, opts);
  if (opts.verbose)
    console.log(`========== testpack options: ${JSON.stringify(opts,null,2)}`);
  console.log(`========== testpack: running npm pack`);
  var tgzName = runNpmPack(pkg, opts);
  
  var testFolder = opts["test-folder"] = opts["test-folder"] || '.packtest';
  console.log(`========== testpack: preparing test folder: ${testFolder}`);
  pkg = transformPackageJson(pkg, opts);
  fsextra.ensureDirSync(testFolder);
  var newJson = JSON.stringify(pkg, undefined, 2);
  var newJsonFn = path.join(testFolder, "package.json");
  if (opts.verbose)
    console.log("========== writing " + newJsonFn);
  fs.writeFileSync(newJsonFn, newJson, 'utf8');
  
  var originalDir = path.relative(testFolder, '.');
  if (opts.verbose)
    console.log("========== cd " + testFolder);
  process.chdir(testFolder);
  if (opts.verbose)
    console.log("========== installing packages with `npm install`");
  run("npm", ["install"]);
  for (let pkgName of opts.install || [])
    run("npm", ["install", "--save-dev", pkgName]);
  if (opts.verbose)
    console.log(`========== npm install ${tgzName}`);
  var tgzName2 = path.relative(testFolder, tgzName);
  run("npm", ["install", tgzName2]);

  var testFiles = getTestFiles(opts, originalDir)
  if (opts.verbose)
    console.log("========== copying " + JSON.stringify(testFiles));
  copyFileTree(testFiles, originalDir, '.');
  var editCount = transformAllImports(testFiles, opts);
  console.log(`========== testpack: ${testFiles.length} test files copied to ${testFolder}, ${editCount} changed`);
  
  var script = opts["test-script"] || "test";
  console.log(`========== testpack: running ${script} script`);
  run("npm", ["run", script]);
  
  process.chdir(originalDir);
  var dirToRemove = opts.rmdir ? testFolder : path.join(testFolder, 'node_modules');
  console.log(`========== testpack: deleting ${dirToRemove}`);
  fsextra.remove(dirToRemove);
}

export const defaultTestPatterns = ["*test*/*", "test*", "*test.*", "*tests.*"];

/** Converts args (produced by minimist or read from package.json)
 *  to the Options interface and performs type checking. */
export function refineOptions(args: any): Options {
  var k: string, i = 0, c: string;
  if (args[k = 'test-files'] == null || args[k].length === 0) {
    args[k] = args._;
    delete args._;
  }
  maybeUpgradeToArrayOfString(args, k = 'test-files', false);
  if (!args[k] || args[k].length === 0)
    args[k] = defaultTestPatterns;
  maybeUpgradeToArrayOfString(args, 'nontest', false);

  expect(args[k = 'packagejson-replace'] === undefined ||
         args[k] instanceof Object, `${k} should be an object`);
  if (args[k = 'packagejson'] !== undefined) {
    var specs = Array.isArray(args[k]) ? args[k] : [args[k]];
    var mergings = {}, replaces = {};
    try {
      for (var i = 0; i < specs.length; i++) {
        var spec = specs[i];
        if (typeof spec === 'string') {
          if (spec.charAt(0) === '+')
            Object.assign(mergings, evalToObject(spec.slice(1)));
          else
            Object.assign(replaces, evalToObject(spec));
        } else {
          expect(spec instanceof Object, `packagejson must contain object(s)`);
          Object.assign(mergings, spec);
        }
      }
    } catch (e) {
      throw `Error in 'packagejson' option: ${(e as Error).message}`;
    }
    args['packagejson'] = mergings;
    if (Object.keys(replaces).length > 0)
      args['packagejson-replace'] = replaces;
  }
  expectType(args, 'packagejson-file', 'string');

  if (args[k = 'replace-import'] !== undefined) {
    maybeUpgradeToArrayOfString(args, k, false);
    expect((args[k] as string[]).every(v => v[0] === v[v.length-1] && v.indexOf(v[0], 1) < v.length-1), 
      "Syntax error in replace-import: expected three slashes/delimiters");
  }
  expectType(args, 'replace-test-imports', 'boolean');

  if (args[k = 'regex'] !== undefined) {
    if (typeof args[k] === 'string')
      args[k] = [args[k]];
    else
      expect(Array.isArray(args[k]), `${k} should be an array`);
    var regexes: any[] = args[k];
    for (var r = 0; r < regexes.length; r++) {
      var regex = regexes[r];
      if (typeof regex === 'string') {
        while((c = regex.charAt(i)) >= 'a' && c <= 'z' || 
              c >= 'A' && c <= 'Z' || c == ',')
              i++;
        var exts = regex.slice(0, i).split(',');
        var end_i = regex.lastIndexOf(regex.charAt(i));
        expect(i < regex.length - 1 && end_i > i, "syntax error in 'regex' option");
        regexes[r] = { exts, regex: regex.slice(i+1, end_i) };
        if (end_i + 1 < regex.length)
          regexes[r].regexOptions = regex.slice(end_i + 1);
        regex = regexes[r];
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
        args[k] = flatten(args[k].map((s: string) => s.split(',')));
      return true;
    }
    return false;
  }
  function splitInTwo(s:string, delim:string) {
    let i = s.indexOf(delim);
    return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + delim.length)];
  }
}

export function readPackageJson(filename?: string): PackageJson {
  filename = filename || "package.json";
  // If package.json not found, try parent folders
  while (!fs.existsSync(filename)) {
    try {
      // Use chdir because all other files are relative to package.json
      process.chdir('..');
    } catch {
      break;
    }
  }
  try {
    var packageText = fs.readFileSync(filename, 'utf8');
    return JSON.parse(packageText) as PackageJson;
  } catch(e) {
    throw `Error reading ${filename}: ${e}`;
  }
}

export function combineOptions(pkg: PackageJson, opts: Options): Options {
  if (!pkg.testpack)
    return opts;
  var pkgArgs: Options = refineOptions(Object.assign({}, pkg.testpack));
  return Object.assign(pkgArgs, opts);
}

export function transformPackageJson(pkg: PackageJson, opts: Options): PackageJson
{
  pkg = Object.assign({}, pkg); // clone it
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
    expect(typeof edits === 'object', "packagejson should be an object");
    pkg = merge(pkg, edits);
  }
  return pkg;
}

export function runNpmPack(pkg: PackageJson, opts: Options): string {
  var pkgName = opts.prepacked || `${pkg['name']}-${pkg['version']}.tgz`;
  if (opts.prepacked == undefined) {
    var error = run("npm", ["pack"]).status;
    if (error) throw `npm pack failed (code ${error})`;
  }
  if (!fs.existsSync(pkgName))
    throw `Expected npm pack to make ${pkgName} but it doesn't exist.`;
  return pkgName;
}

export function getTestFiles(opts: Options, fromFolder?: string): string[] {
  // Combine all inclusion patterns into one string, as glob requires
  // Note: glob won't match `{foo*}` against `food` - a comma is required 
  // inside braces. So we must omit the braces if test-files has length 1.
  var patterns = opts["test-files"];
  var includes = patterns.length === 1 ? patterns[0] : "{" + patterns.join(',') + "}";
  return glob.sync(includes, {cwd: fromFolder, ignore: opts.nontest});
}
export function copyFileTree(files: string[], fromFolder: string, toFolder: string)
{
  for (var file of files) {
    var toFile = path.join(toFolder, file);
    fsextra.ensureDirSync(path.dirname(toFile));
    fs.copyFileSync(path.join(fromFolder, file), toFile);
  }
}

/** Reads a set of test files and scans it for import/require commands, 
 *  performing replacements on those.
 *  @param opts  opts.regex (combined with defaultRegexes) specifies how
 *         to find import strings, and opts['replace-import'] controls
 *         replacement patterns. Files that appear to be test files
 *         (opts['test-files']) are normally left unchanged.
 */
export function transformAllImports(testFiles: string[], opts: Options) {
  var replacements = getReplacementPairs(opts["replace-import"]);
  var editCount = 0;
  for (var filename of testFiles) {
    if (transformImports(filename, filename, opts, replacements))
      editCount++;
  }
  return editCount;
}

function transformImports(inputFile: string, outputFile: string, opts: Options, replacementPairs?: [RegExp,string][])
{
  var matchers = getMatchersFor(inputFile, opts);
  if (matchers.length > 0) {
    var file = fs.readFileSync(inputFile, 'utf8');
    var lines = file.split('\n');
    if (transformImportsCore(lines, matchers, opts, replacementPairs)) {
      fs.writeFileSync(outputFile, lines.join('\n'), 'utf8');
      return true;
    }
  }
  return false;
}

/** Scans a test file's lines for import/require commands via regex,
 *  performing replacements on those. Regexes are imperfect but save
 *  us the trouble of importing some huge JS/TS parser (and also allow
 *  users to support languages other than JS/TS.)
 *  @param matchers  Regular expressions used to locate import/require.
 *         First capture group must be the filename. Don't use "g" option.
 *  @param opts  opts.regex (combined with defaultRegexes) specifies how
 *         to find import strings, and opts['replace-import'] controls
 *         replacement patterns. Files that appear to be test files
 *         (opts['test-files'] except opts.nontest) are left unchanged 
 *         unless opts["replace-test-imports"] is true.
 *  @param replacementPairs  optional: cached interpretation of 
 *         opts['replace-import']
 */
export function transformImportsCore(lines: string[], matchers: RegExp[], opts: Options, replacementPairs?: [RegExp,string][])
{
  if (!replacementPairs)
    replacementPairs = getReplacementPairs(opts["replace-import"]);

  let changed = false;
  for (var l = 0; l < lines.length; l++) {
    console.log("====line "+lines[l]);
    for (var m = 0; m < matchers.length; m++) {
      let stop = false;
      for (var i = 0; !stop && i < lines[l].length;) {
        stop = true;
        let match = lines[l].slice(i).match(matchers[m]);
        if (match != null) {
          let importFn = match[1];
          if (importFn === undefined)
            break;

          // Check if a test file is imported (which should be left unchanged)
          // Ugh: ./test.js does NOT match *test.*, so strip off ./ prefix
          // TODO: In general I guess we should "adapt" the path to the root folder ... or something
          let importFn2 = importFn.match(/^.[/\\]/) ? importFn.slice(2) : importFn;
          if (opts["replace-test-imports"] ||
            !opts["test-files"].some(tp => 
              globmatch(importFn2 + ".js", tp) || globmatch(importFn2, tp)) ||
            (opts.nontest || []).some(ig => globmatch(importFn, ig)))
          {
            // Apply replacement patterns
            for (var [from, to] of replacementPairs) {
              importFn = importFn.replace(from, to);
            };
            if (importFn !== match[1]) {
              // A replacement was made. Insert it into the original line and redo
              let iStart = i + match.index! + match[0].lastIndexOf(match[1]);
              let iEnd = iStart + match[1].length;
              lines[l] = lines[l].slice(0, iStart) + importFn + lines[l].slice(iEnd);
              changed = true;
              stop = false;
              i = iStart + importFn.length;
            }
          }
        }
      }
    }
  }
  return changed;
}

function getReplacementPairs(patterns?: string[]): [RegExp,string][] {
  if (patterns)
    return patterns.map(v => {
      var delim = v[v.length - 1];
      var first = v.indexOf(delim);
      var middle = v.indexOf(delim, first + 1);
      return [new RegExp(v.slice(first + 1, middle)),
              v.slice(middle + 1, v.length - 1)] as [RegExp, string];
    });
  else
    return [[/\.\.?[/\\]src[/\\](.*)/, "$1"], [/\.[/\\](.*)/, "$1"]];
}

var jsExts = ["js", "jsx", "mjs", "ts", "tsx"];
export const defaultRegexes: ImportMatcher[] = [
  { exts: jsExts, regex: /require\s*\(\s*"((?:[^\\"]|\\.)*)"/ },
  { exts: jsExts, regex: /require\s*\(\s*'((?:[^\\']|\\.)*)'/ },
  { exts: jsExts, regex: /[a-zA-Z0-9_}]\s*from\s*"((?:[^\\"]|\\.)*)"/ },
  { exts: jsExts, regex: /[a-zA-Z0-9_}]\s*from\s*'((?:[^\\"]|\\.)*)'/ },
];

/** Gets regexes for finding import/require expressions in a particular file
 *  based on opts.regex. */
export function getMatchersFor(fileName: string, opts: Options): RegExp[]
{
  var ext = fileName.indexOf('.') > 0 ? path.extname(fileName).slice(1) : fileName;
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

export function evalToObject(data: string) {
  if (data.charAt(0) !== '{')
    data = "{"+data+"}";
  data = "("+data+")";
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
  for (let key of Object.keys(newVal)) {
    if (newVal[key] === undefined)
      delete obj[key];
    else if (obj[key] === undefined)
      obj[key] = newVal[key];
    else
      obj[key] = merge(obj[key], newVal[key]);
  }
  return obj;
}

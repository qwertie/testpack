#!/usr/bin/env node
import * as fs from 'fs';
import * as fsextra from 'fs-extra';
import * as path from 'path';
import * as process from 'process';
import * as glob from 'glob';
import * as _ from 'underscore';
import globmatch from 'minimatch';
import {isPrimitive, run, runAndThrowOnFail, flatten} from './misc';
import { SpawnSyncReturns, execSync } from 'child_process';

export type PackageJson = {
  "name"?: string;
  "version"?: string;
  "dependencies"?: any;
  "devDependencies"?: any;
  "optionalDependencies"?: any;
  "scripts"?: any;
  "testpack"?: any;
  "files"?: any;
};
export type ImportMatcher = { exts:string[], regex:string|RegExp, regexOptions?:string };

export interface Options {
  "test-files": string[];      // glob patterns
  "nontest"?: string[];        // files not to be treated as tests
  "packagejson"?: any;         // --package.json=...
  "packagejson-file"?: string; // file to load (generated file is always package.json)
  "replace-import"?: string[]; // each string has the form /pat1/pat2/ (delimiter can vary)
  "replace-test-imports"?: boolean; // normally false
  "regex"?: ImportMatcher[];
  "install"?: string[];
  "keep"?: string[];
  "test-folder"?: string;
  "rmdir"?: boolean;
  "dirty"?: boolean;
  "setup-command"?: string;  // A command to run instead of "npm install".
  "noinstall"?: boolean;
  "test-script"?: string;
  "verbose"?: boolean;
  "delete-on-fail"?: boolean; // Delete tgz and test folder when npm test fails?
  "prepacked"?: string|boolean;
}

/**
 * Implements the testpack command-line tool.
 * @param opts Options
 */
export function testPack(opts: Options): SpawnSyncReturns<Buffer>
{
  var success = false;
  
  // Uses chdir to parent directory if necessary to find package.json
  var pkg = readPackageJson(opts['packagejson-file']);
  opts = combineOptions(pkg, opts);
  if (opts.verbose)
    console.log(`============ testpack options: ${JSON.stringify(opts,null,2)}`);
  var pkgName = pkg.name || 'untitled';
  var testFolder = opts["test-folder"] || path.join('..', pkgName + '-testpack');
  
  // Since we plan to delete the test folder, let's make sure it's not the 
  // current folder or its parent folder.
  if ((process.cwd() + '/').startsWith(path.resolve(testFolder) + '/')) {
    console.log("Whoa there, buddy! Don't you know I start by destroying the test folder?");
    throw new Error("The test folder is set to this folder or its parent!");
  }

  if (!pkg.files || !Array.isArray(pkg.files)) {
    console.log(`========== testpack WARNING: no "files" section in package.json!`);
    console.log(`==========   Without it you may add files to your package accidentally`);
  }
  console.log(`========== testpack: running npm pack`);
  var tgzName = runNpmPack(pkg, opts);
  
  console.log(`========== testpack: preparing test folder: ${testFolder}`);
  if (!opts.dirty && fsextra.existsSync(testFolder)) {
    if (opts.verbose)
      console.log(`============ testpack: deleting contents of ${testFolder}`);
    fsextra.emptyDirSync(testFolder);
  }
  pkg = transformPackageJson(pkg, opts);
  fsextra.ensureDirSync(testFolder);

  var originalDir = path.relative(testFolder, '.');
  if (opts.verbose)
    console.log("============ cd " + testFolder);
  process.chdir(testFolder);

  try {
    var newJson = JSON.stringify(pkg, undefined, 2);
    if (opts.verbose)
      console.log("============ writing package.json");
    fs.writeFileSync("package.json", newJson, 'utf8');
    opts["test-folder"] = testFolder;

    if (opts.verbose)
      console.log(`============ installing packages with \`${opts["setup-command"] || "npm install"}\``);
    var installStatus = 0;
    if (opts["setup-command"] !== undefined) {
      if (opts["setup-command"] !== "")
        execSync(opts["setup-command"]!, {cwd: '.', stdio: 'inherit'});
    } else {
      if (!(fs.existsSync("package-lock.json") && run("npm", ["ci"]).status != 0))
        runAndThrowOnFail("npm", ["install"]);
    }
    for (let pkgName of opts.install || [])
      runAndThrowOnFail("npm", ["install", "--save-dev", pkgName]);
    var tgzName2 = path.join(originalDir, tgzName);
    if (opts.verbose)
      console.log(`============ npm install ${tgzName2}`);
    runAndThrowOnFail("npm", ["install", "--no-save", tgzName2]);

    opts.nontest = (opts.nontest || []).concat(tgzName);
    var testFiles = getTestFiles(opts, originalDir)
    if (opts.verbose)
      console.log("============ copying " + JSON.stringify(testFiles));
    copyFileTree(testFiles, originalDir, '.');
    var editCount = new ImportTransformer(opts, pkgName).transformAllImports(testFiles);
    console.log(`========== testpack: ${testFiles.length} test files copied to ${testFolder}, ${editCount} changed`);
    
    var script = opts["test-script"] || "test";
    console.log(`========== testpack: running ${script} script`);
    var result = run("npm", ["run", script]);
    
    success = result.status === 0;
    if (success && opts.verbose)
      console.log(`============ testpack: ${script} script appeared to succeed`);
    return result;
  }
  finally
  {
    // Epilogue: clean up by deleting stuff
    process.chdir(originalDir);
    if (success || opts["delete-on-fail"]) {
      if (opts.rmdir) {
        console.log(`========== testpack: deleting ${testFolder}`);
        try {
          fsextra.remove(testFolder);
        } catch(e) {
          console.log(`========== ERROR: ${e.message}`);
        }
      }
      if (!opts.prepacked) {
        if (opts.verbose)
          console.log(`============ testpack: deleting ${tgzName}`);
        try {
          fs.unlinkSync(tgzName);
        } catch(e) {
          console.log(`========== ERROR deleting ${tgzName}: ${e.message}`);
        }
      }
    }
  }
}

export const defaultTestPatterns = ["*test*/**", "test*", "*test.*", "*tests.*", "tsconfig.json"];

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

  if (args[k = 'packagejson'] !== undefined) {
    // Validate non-object options. Originally this code converted the
    // strings to objects; unfortunately we need to be able to store the 
    // output of refineOptions() in JSON format so it can go in package.json,
    // and you can use undefined as a delete command:
    //   --packagejson=+foo:{bar:undefined}
    // undefined is not allowed in JSON so we must leave it in string format,
    // although this means it will have to be eval'd twice: once here for
    // validation and again when the edits are actually applied.
    try {
      for (var spec of asArray(args[k]))
        editSpecToObject(spec);
    } catch (e) {
      throw new Error(`Error in 'packagejson' option: ${e.message}`);
    }
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
  expectType(args, 'dirty', 'boolean');
  expectType(args, 'setup-command', 'string');
  expectType(args, 'test-script', 'string');
  expectType(args, 'delete-on-fail', 'boolean');
  if (args[k = 'prepacked'] !== undefined) {
    expect(args[k] !== null && (typeof args[k] === 'boolean' || typeof args[k] === 'string'),
      `${k} should be a boolean or string`);
  }

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
      args[k] = asArray(args[k]);
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

function expect(test: boolean, err: string) {
  if (!test) throw new Error(err);
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function editSpecToObject(spec: any) {
  if (typeof spec === 'string')
    spec = evalToObject(spec);
  expect(spec instanceof Object, `packagejson must be object or string`);
  return spec;
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
    throw new Error(`Error reading ${filename}: ${e.message}`);
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

  // package.json's name is not allowed to be the same as one of its dependencies.
  pkg.name += "-test"; // So make it unique.

  pkg.testpack = opts; // Remember options used to make the new package.json

  // Remove the most unimportant settings to reduce clutter
  delete (pkg as any).description;
  delete (pkg as any).keywords;
  delete (pkg as any).bugs;
  delete (pkg as any).bin;   // not applicable in test folder
  delete (pkg as any).main;  // not applicable in test folder
  delete (pkg as any).files; // not applicable in test folder
  delete (pkg as any).peerDependencies;    // not applicable in test folder
  delete (pkg as any).bundledDependencies; // not applicable in test folder

  // Delete all dependencies except popular unit test frameworks
  // and packages that the user whitelisted.
  var whitelist = ["mocha", "jasmine", "jest", "qunit", "enzyme", "tape", "ava"];
  if (opts.keep)
    whitelist = whitelist.concat(opts.keep);
  pkg.dependencies = filterToWhitelist(pkg.dependencies, whitelist);
  pkg.devDependencies = filterToWhitelist(pkg.devDependencies, whitelist);
  pkg.optionalDependencies = filterToWhitelist(pkg.optionalDependencies, whitelist);
  function filterToWhitelist(deps: any, whitelist: string[]) {
    if (deps)
      deps = _.pick(deps, (v:any,key:any) => {
        return whitelist.some(v => globmatch(key, v));
      });
    return deps;
  }

  if (pkg.scripts) {
    delete pkg.scripts.prepare;
    delete pkg.scripts.postinstall;
  }
  
  for (var spec of asArray(opts['packagejson'] || [])) {
    let edits = editSpecToObject(spec);
    pkg = merge(pkg, edits);
  }
  return pkg;
}

export function runNpmPack(pkg: PackageJson, opts: Options): string {
  var pkgName = `${pkg['name']}-${pkg['version']}.tgz`;
  if (typeof opts.prepacked === 'string')
    pkgName = opts.prepacked;
  if (!opts.prepacked) {
    var error = run("npm", ["pack"]).status;
    if (error) throw new Error(`npm pack failed (code ${error})`);
  }
  if (!fs.existsSync(pkgName))
    throw new Error(`Expected ${pkgName} to exist but it doesn't.`);
  return pkgName;
}

export function getTestFiles(opts: Options, fromFolder?: string): string[] {
  // Combine all inclusion patterns into one string, as glob requires
  // Note: glob won't match `{foo*}` against `food` - a comma is required 
  // inside braces. So we must omit the braces if test-files has length 1.
  var patterns = opts["test-files"];
  var includes = patterns.length === 1 ? patterns[0] : "{" + patterns.join(',') + "}";
  var ignore = [path.join(opts["test-folder"]!, '**')].concat(opts.nontest || []);
  return glob.sync(includes, {cwd: fromFolder, ignore, nodir: true});
}
export function copyFileTree(files: string[], fromFolder: string, toFolder: string)
{
  for (var file of files) {
    var toFile = path.join(toFolder, file);
    fsextra.ensureDirSync(path.dirname(toFile));
    fs.copyFileSync(path.join(fromFolder, file), toFile);
  }
}

/** Helper class for transforming import/require commands */
export class ImportTransformer
{
  replacementPairs: [RegExp,string][];
  constructor(public opts: Options, public packageName: string) {
    this.replacementPairs = ImportTransformer.getReplacementPairs(packageName, opts["replace-import"]);
  }

  /** Reads a set of test files and scans it for import/require commands, 
   *  performing replacements on those.
   *  @param opts  opts.regex (combined with defaultRegexes) specifies how
   *         to find import strings, and opts['replace-import'] controls
   *         replacement patterns. Files that appear to be test files
   *         (opts['test-files']) are normally left unchanged.
   */
  transformAllImports(testFiles: string[]) {
    var editCount = 0;
    for (var filename of testFiles) {
      if (this.transformImports(filename, filename))
        editCount++;
    }
    return editCount;
  }

  transformImports(inputFile: string, outputFile: string)
  {
    var matchers = this.getMatchersFor(inputFile);
    if (matchers.length > 0) {
      if (this.opts.verbose)
        console.log(`============ trying ${this.replacementPairs.length} replace-import pair(s) in ${inputFile}`);
      var file = fs.readFileSync(inputFile, 'utf8');
      var lines = file.split('\n');
      if (this.transformImportsCore(lines, matchers)) {
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
  transformImportsCore(lines: string[], matchers: RegExp[])
  {
    let changed = false, opts = this.opts;
    for (var l = 0; l < lines.length; l++) {
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
              for (var [from, to] of this.replacementPairs) {
                importFn = importFn.replace(from, to);
              };
              if (opts.verbose)
                console.log(`============ replacement on line ${l}: ${match[1]} ==> ${importFn}`);
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

  static getReplacementPairs(pkgName: string, patterns?: string[]): [RegExp,string][] {
    if (patterns)
      return patterns.map(v => {
        var delim = v[v.length - 1];
        var first = v.indexOf(delim);
        var middle = v.indexOf(delim, first + 1);
        var regex = matchWhole(v.slice(first + 1, middle));
        var repl = v.slice(middle + 1, v.length - 1);
        return [new RegExp(regex.replace("$P", pkgName)),
                            repl.replace("$P", pkgName)] as [RegExp, string];
      });
    else
      return [[/^\.\.?([\/\\].*)$/, pkgName + "$1"], [/^\.\.?$/, pkgName]];

    function matchWhole(s: string) {
      return s[0] === '^' || s.endsWith('$') ? s : ('^' + s + '$');
    }
  }

  static jsExts = ["js", "jsx", "mjs", "ts", "tsx"];
  static defaultRegexes: ImportMatcher[] = [
    { exts: ImportTransformer.jsExts, regex: /require\s*\(\s*"((?:[^\\"]|\\.)*)"/ },
    { exts: ImportTransformer.jsExts, regex: /require\s*\(\s*'((?:[^\\']|\\.)*)'/ },
    { exts: ImportTransformer.jsExts, regex: /[a-zA-Z0-9_}]\s*from\s*"((?:[^\\"]|\\.)*)"/ },
    { exts: ImportTransformer.jsExts, regex: /[a-zA-Z0-9_}]\s*from\s*'((?:[^\\"]|\\.)*)'/ },
  ];
  
  /** Gets regexes for finding import/require expressions in a particular file
   *  based on opts.regex. */
  getMatchersFor(fileName: string): RegExp[]
  {
    var ext = fileName.indexOf('.') > 0 ? path.extname(fileName).slice(1) : fileName;
    var results: RegExp[] = [];
    for (var matcher of ImportTransformer.defaultRegexes.concat(this.opts.regex || [])) {
      if (matcher.exts.indexOf(ext) > -1) {
        if (matcher.regex instanceof RegExp)
          results.push(matcher.regex);
        else
          results.push(new RegExp(matcher.regex, matcher.regexOptions));
      }
    }
    return results;
  }
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

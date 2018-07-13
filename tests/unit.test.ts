// Install:
// npm install --global jest babel-core typescript ts-jest
import * as tp from "../src/npm-testpack";

test('refineOptions 1', () => {
  var args = { 
    "test-files": "*test*",
    packagejson: 'five:5',
    'replace-import': ['#foo/(.*)#bar/$1#', '/a/b/'],
    regex: ['java/import\\s*(.*);/'],
    install: ['fs-extra'],
    keep: ['jquery', 'lodash'],
    nontest: ['*testpack.ts', 'foodForTest.js'],
  };
  var opts = tp.refineOptions(args);
  
  expect(opts).toEqual({
    'test-files': ["*test*"],
    'packagejson': 'five:5',
    'replace-import': ['#foo/(.*)#bar/$1#', '/a/b/'],
    "regex": [{
      "exts": [ "java" ],
      "regex": "import\\s*(.*);"
    }],
    install: ['fs-extra'],
    keep: ['jquery', 'lodash'],
    nontest: ['*testpack.ts', 'foodForTest.js'],
  });
});
  
test('refineOptions 2', () => {
  var args = { _: [ '*test*' ],
    packagejson: [
      'five:5',
      'scripts:{test:\'jest\'}',
      "{'house':{'attic':undefined,'garage':['powertools']}}",
      '{ "house": { "attic": { "clean": true } } }',
    ],
    'test-folder': '../packtest',
    'replace-import': '#foo/(.*)#bar/$1#',
    regex: 'cs#using\\s*(.*);#',
    rmdir: true,
    'test-script': 'packtest',
    install: 'fs-extra',
    keep: 'jquery',
    prepacked: 'foo.tgz',
    nontest: '*testpack.ts',
    verbose: true
  };
  var opts = tp.refineOptions(args);
  
  expect(opts).toEqual({
    "test-files": ["*test*"],
    "packagejson": [
      'five:5',
      'scripts:{test:\'jest\'}',
      "{'house':{'attic':undefined,'garage':['powertools']}}",
      '{ "house": { "attic": { "clean": true } } }',
    ],
    "replace-import": ["#foo/(.*)#bar/$1#"],
    "regex": [{
      "exts": [ "cs" ],
      "regex": "using\\s*(.*);"
    }],
    "test-folder": "../packtest",
    "rmdir": true,
    "test-script": "packtest",
    "install": ["fs-extra"],
    "keep": ["jquery"],
    "prepacked": "foo.tgz",
    "nontest": ["*testpack.ts"],
    "verbose": true,
  });
});

test('refineOptions error handling', () => {
  expect(() => tp.refineOptions({ packagejson: 'garbage' })).toThrow(/packagejson/);
  expect(() => tp.refineOptions({ packagejson: '7' })).toThrow(/packagejson/);
  expect(() => tp.refineOptions({ packagejson: '{two:2}' })).not.toThrow();
  expect(() => tp.refineOptions({ packagejson: 123 })).toThrow(/packagejson.*object/);
  expect(() => tp.refineOptions({ packagejson: [123] })).toThrow(/packagejson.*object/);
  expect(() => tp.refineOptions({ packagejson: [{ two: 2 }] })).not.toThrow();
  expect(() => tp.refineOptions({ 'test-files': 123 })).toThrow(/test-files/);
  expect(() => tp.refineOptions({ 'nontest': [123] })).toThrow(/nontest/);
  expect(() => tp.refineOptions({ 'packagejson-file': {two:2} })).toThrow(/packagejson-file/);
  expect(() => tp.refineOptions({ 'replace-import': 123 })).toThrow(/replace-import/);
  expect(() => tp.refineOptions({ 'replace-import': '!invalid!' })).toThrow(/replace-import/);
  expect(() => tp.refineOptions({ 'regex': 123 })).toThrow(/regex/);
  expect(() => tp.refineOptions({
    'regex': [{
      "exts": ["java"], "regex": "import\\s*(.*);"
    }]
  })).not.toThrow();
  expect(() => tp.refineOptions({ 'regex': [{"exts": ["java"]}] })).toThrow(/regex/);
  expect(() => tp.refineOptions({ 'regex': [{"exts":123,"regex":""}] })).toThrow(/array of string/);
  expect(() => tp.refineOptions({ 'regex': [{"exts":["x"],"regex":123}] })).toThrow(/regex/);
  expect(() => tp.refineOptions({ 'install': 123 })).toThrow(/install/);
  expect(() => tp.refineOptions({ 'install': ['foo',123] })).toThrow(/install/);
  expect(() => tp.refineOptions({ 'keep': ['foo',123] })).toThrow(/keep/);
  expect(() => tp.refineOptions({ 'test-folder': ['foo'] })).toThrow(/test-folder/);
  expect(() => tp.refineOptions({ 'rmdir': 'maybe' })).toThrow(/rmdir/);
  expect(() => tp.refineOptions({ 'test-script': [] })).toThrow(/test-script/);
  expect(() => tp.refineOptions({ 'prepacked': ['blah'] })).toThrow(/prepacked/);
  expect(() => tp.refineOptions({ 'delete-on-fail': 'YES' })).toThrow(/delete-on-fail/);
});

test('readPackageJson', () => {
  expect(tp.readPackageJson()).toHaveProperty('devDependencies');
});

test('combineOptions', () => {
  expect(tp.combineOptions(
    { testpack: { packagejson: {two:2}, verbose:false } },
                { packagejson: {five:5},
                  "test-files": tp.defaultTestPatterns })).
        toEqual({ packagejson: {five:5}, verbose: false,
                  "test-files": tp.defaultTestPatterns });
});

 
test('transformPackageJson', () => {
  var pkg = { 
    "name": "foo", 
    "version": "1.0.0",
    "dependencies": {"etc": "1.0.0", "jest": "^23.0.0", "kept": "1.0.0"},
    "devDependencies": {"mocha": "^3.0.0", "who-cares": "whatevs"},
    "whatever": true,
    "house": { "attic": { "worthless": true, "garbage": true }, 
               "garage": [ "car", "bike" ] }
  } as tp.PackageJson;
  pkg = tp.transformPackageJson(pkg, { 
    "test-files": tp.defaultTestPatterns,
    "packagejson": [
      { two:2 }, 
      // Delete house.attic, then add new stuff in a separate command
      { "house": { "attic": undefined, "garage": ["power tools"] } },
      { "house": { "attic": { "clean": true } },
        "testpack": undefined,
        "whatever": undefined
      }
    ],
    "keep": ['kept']
  });
  expect(pkg).toEqual({
    "name": "foo-test", 
    "version": "1.0.0",
    "dependencies": {"jest": "^23.0.0", "kept": "1.0.0"},
    "devDependencies": {"mocha": "^3.0.0"},
    "two": 2,
    "whatever": undefined,
    "house": { "attic": { "clean": true }, 
               "garage": [ "car", "bike", "power tools" ] },
    "testpack": undefined,
  });
});

test('getTestFiles', () => {
  var tf = tp.getTestFiles({ 'test-files': tp.defaultTestPatterns, nontest: [ "dist/*" ] }, '.');
  expect(tf.sort()).toEqual(['tests/integration.test.ts', 'tests/unit.test.ts']);
});

test('transformImportsCore', () => {
  // Ideally our regexes would detect and ignore strings, but it's hard.
  // The \t characters ensure that this code isn't changed during 
  // the Dress Rehearsal, when we're running testpack on this code.
  var lines = [
    "var fs = require\t('fs')",
    "var bar = require\t('./bar'), baz = require('./baz')",
    'import * as foo from\t"../src/foo"',
    'import * as foot from\t"./foo-test"',
    'var data = require\t("./__test__/file.xml")',
    'var data = require\t(".\\src\\file.xml")',
    "the_end"
  ];
  var opts = {'test-files': tp.defaultTestPatterns};
  var matchers = tp.getMatchersFor("example.js", opts);
  expect(matchers.length).toBeGreaterThan(1);
  tp.transformImportsCore(lines, matchers, opts);
  expect(lines).toEqual([
    "var fs = require\t('fs')",
    "var bar = require\t('bar'), baz = require('baz')",
    'import * as foo from\t"foo"',
    'import * as foot from\t"./foo-test"',
    'var data = require\t("./__test__/file.xml")',
    'var data = require\t("file.xml")',
    "the_end"
  ]);
});

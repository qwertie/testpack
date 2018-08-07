testpack: Test your package before publishing
=================================================

Testpack attempts to verify that your npm package is set up properly by 
installing the packaged version in a special test folder with its own 
custom package.json file, and running a copy of your unit tests against it.

**Usage:** `testpack [Options] [<Test patterns>]`

`<Test patterns>` are glob patterns used to recognize source files that are
test-related and so should be copied to the new project. The default test
patterns are `test* *test.* *tests.* *test*/** tsconfig.json`.
Note: the [`glob` package](https://www.npmjs.com/package/glob) is used to 
match test patterns. It requires slash (/) as the path separator even on
Windows; backslashes escape "special" characters such as braces.

Here's what it does:

1. It runs `npm pack` to create a preview copy of your package.
2. It creates a test folder. By default the folder is *../YPN-testpack*
   where *YPN* is Your Package's Name, and if the test folder already 
   exists, its contents are deleted. You can use `--test-folder` to 
   change the folder's path and name.
3. In the test folder, it creates a new package.json file derived from 
   your existing one, in which all dependencies are deleted except common
   unit test frameworks (e.g. jasmine, mocha, jest). With `--packagejson`
   you can request additional changes to the new package.json.
3. It runs `npm install` in the test folder
4. It installs any additional packages you requested with `--install`
5. It unpacks the tgz file generated by `npm pack` using `npm install`
6. It copies your test files to the new folder, preserving their 
   original directory structure.
7. It changes import/require commands in the tests. Except when importing
   test files, the "local" prefix `.` or `..` is changed to the package
   name, so that your tests are importing from *node_modules* instead.
   For example, if your package is called `mypkg` and your test code
   says `import {...} from "./module"`, testpack changes it to
   `import {...} from "mypkg/module"`. You should use the `"main"` option
   in package.json to specify the default module, and then you can write
   `require(".")` to import it, which will become `require("mypkg")`
   in the test folder.
8. It runs `npm run test` (or another script according to `--test-script`)

All command-line options are optional. By default, if your test files
have `import` or `require` commands that refer to a string starting with
`./` or `../src/`, that prefix will be stripped out of the copy unless
they refer to one of the test files. 

Options
-------

~~~
--dirty
      The contents of the test folder are normally deleted at the start.
      This option skips the deletion step, potentially leaving extra files
      in the test folder (also: runs faster npm ci instead of npm install)
--setup-command=command
      A setup command to run instead of `npm install` (your package is
      still installed afterward with `npm install ________.tgz` and 
      `npm install` is still invoked if you use `--install`.) To save
      time by skipping install when packages in the test folder are 
      already installed, use `--dirty --setup-command=""`.
-p, --packagejson=key:value  
      Merges data into the new package.json file. If the new value is a 
      primitive, it overwrites the old value. If the old value is a 
      primitive, it is treated as an array. If both are arrays, they are
      concatenated. If either one is an object, they are merged in the 
      obvious way, recursively. For example:
        Old value: `{"a":["hi"], "b":7, "c":[3], "x":{"D":4}}`
        New value: `{"a":1,"b":[8],"c":[4],"x":{"D":{"two":2},"E":5}}`
        Out: `{"a":1,"b":[7,8],"c":[3,4],"x":{"D":{"0":4,"two":2},"E":5}}`
      You can use `undefined` to delete an existing value, e.g.
        --packagejson={testpack:undefined,repository:undefined}
-o, --test-folder=path
      Path to test folder. Created if necessary.
-r, --replace-import !pat1!pat2!
      Searches js/mjs/ts/tsx test files for require/import filenames using 
      regex pattern 1, replacing it with pattern 2. Instead of `!`s you are
      allowed to use any punctuation mark that doesn't appear in the 
      patterns. Pattern 2 can use $1 through $9 to re-emit captured 
      strings, and $P is replaced with your package's name. Replacements 
      only affect non-test files unless you add --replace-test-imports. 
      If this option is not used then the following default replacement 
      patterns are used:
        |\.\.?|$P| and |\.\.?([\/\\].*)|$P$1|
      Basically, `.` and `..` are replaced with the package name. UTF-8 
      encoding is assumed in test files, and the regex must match the whole 
      filename unless your regex uses `^` or `$`.
--regex ext/regex/
      For the purpose of modifying import/require commands, files with the
      specified extension(s) are searched using this regular expression,
      and the first captured group is treated as a filename that may need 
      to be modified. For example, this built-in regex is used to match
      require commands that use double quotes:
        --regex js/require\s*\(\s*"((?:[^\\"]|\\.)*)"/
      You can specify multiple extensions separated by commas: `js,mjs`
-R, --rmdir
      Remove entire test folder when done (by default, only the the tgz
      produced by `npm pack` is deleted.)
--delete-on-fail
      Delete the test folder & tgz even when tests fail.
-s, --test-script=name
      Name of test script to run with `npm run` (default: `test`).
--install package
      Runs `npm install --save-dev package` in the test project.
--keep package
      Prevents removal of package(s) from dependencies or devDependencies.
--prepacked
      Skips running `npm pack` and looks for the .tgz file it normally
      produces (name-version.tgz). This option also prevents the deletion 
      of the tar.gz file on exit.
--prepacked=file
      Skips running `npm pack` and unpacks the specified file.
--show-json
      Shows the JSON equivalent of the specified arguments, then quits.
      You can put these settings in a "testpack" section of package.json.
-!, --nontest pattern
      Ignores the specified files (glob pattern) when searching for tests.
-v, --verbose
      Emits more text describing what testpack is doing.
~~~

**Caution:** your shell may transform special characters before they reach 
testpack. For example, on Windows, `--packagejson=key:"value"` doesn't work 
because the shell removes the quotes, causing an error message from testpack.

If you prefer, options can be placed in a `"testpack"` section of your 
package.json file. For example,

~~~json
  "testpack": { "test-script":"foo", "verbose": true }
~~~

is equivalent to `--test-script=foo --verbose`.

How to use testpack
-------------------

1. Prepare to your package for publishing as you normally would ([see also](http://typescript-react-primer.loyc.net/publish-npm-package.html))
2. In a terminal: `npm install --save-dev --global testpack-cli`
3. Run it with: `testpack` (add `--verbose` for more detail)
4. Run `npm publish` once your tests pass.
5. To combine steps 4 and 5, use a script like `npm run safePublish` :

        "scripts": {
          "safePublish": "testpack && npm publish",
          ...
        }

**Note:** It's natural to want to put `testpack --prepacked` in your `postpack` script so it runs after `npm pack`, but this doesn't work because `npm pack` calls `postpack` [_before_ it produces the tgz file](https://npm.community/t/postpack-script-runs-before-the-tgz-is-packed/592).

If your package includes commands in `"bin"` in package.json, npm has an [undocumented requirement for a shebang](https://npm.community/t/making-a-command-for-a-package-bin/628). Consider adding some sort of test to make sure your installed command can be invoked ([create an issue](https://github.com/qwertie/testpack/issues) if you want advice).

Tips for TypeScript users
-------------------------

When publishing TypeScript packages on npm, it’s polite to publish code that has been compiled to JavaScript so that people who are not using TypeScript can still use your package. Here are some things to be aware of:

- You need to use `tsc --declaration` (`"declaration": true` in tsconfig.json) to create .d.ts typing files which contain type information. After building your .js and .d.ts files, you don’t even need to publish the original TypeScript source code.
- When importing a published module, I found that VS Code will detect your typing files (e.g. if `"main"` is `dist/index.js` then VS Code finds `dist/index.d.ts`), [**but `tsc` will not**](https://stackoverflow.com/questions/41292559/could-not-find-a-declaration-file-for-module-module-name-path-to-module-nam). Therefore, before you publish, you need an extra option in package.json such as `"typings": "dist/index"` to tell `tsc` where the d.ts file is (the d.ts extension is inferred.) If you forget the `typings` option, `testpack` can only help you notice your mistake if your unit-testing script includes a type-checking mechanism (certain TypeScript tools such as ts-jest do **not** include type checking.)
- `tsc` may give a baffling error, "Cannot write file '[your-module].d.ts' because it would overwrite input file", when your `"typings"` option includes the `.d.ts` file extension. So remove that extension!
- The `"main"` option in your package.json should refer to a .js file and it's a good idea to use `import {...} from "."` _in your tests_ to verify that the `"main"` option is set correctly. But if you do this, `import {...} from "."` may not work in any modules seen by `tsc` because the `js` file doesn't exist until _after_ compilation is finished. You _might_ solve the problem by stripping off the extension from `main` (e.g. use `"main": "foo"` instead of `"main": "foo.js"`). This allows `tsc` to use `.ts` as the default file extension while other tools like `node` use `.js` as the default file extension. However, this won't work if your tsconfig.json is configured to place output in a different place (e.g. `"outDir": "dist"`). In that case, use `import {...} from "."` _only_ in your tests and then exclude your tests with the `exclude` option in [tsconfig.json](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html), e.g. `"exclude": ["node_modules", "**/*.test.ts"]`. This works if you are running tests with a tool that supports TypeScript but ignores the `exclude` option, such as `ts-jest` or `ts-node`.
- You should make sure that the tests which testpack copies to its test folder are importing the compiled JavaScript version, not the TypeScript version. The simplest way to guarantee this is to exclude all .ts files from your package. If you do that, be sure source maps are disabled in your tsconfig.json. In any case, your tests should still be written in TypeScript to make sure that your d.ts files work.

**ts-jest users:** I found it tricky to use ts-jest. In the `"jest"` options in package.json, `"js"` must be included in the list of `"moduleFileExtensions"`, otherwise this error occurs: "Cannot find module './lib/source-map-generator' from 'source-map.js'". However we only want to run ts test files, not js files generated by `tsc`. The solution I chose was to put tests in their own folder and exclude it in tsconfig.json. But if you exclude your tests from tsconfig.json and then run `testpack`, ts-jest will hit you with [bug #618](https://github.com/kulshekhar/ts-jest/issues/618) which the developers declined to fix. To work around this you can teach `testpack` to create a dummy source file in package.json. For example, if tsconfig says your source files are in `src`, use this:

~~~json
  "testpack": {
    "packagejson": {
      "scripts": {
        "fix-ts-jest": "mkdir src && echo \"//avoid ts-jest bug 618\" > src/dummy.ts || cd .",
        "test": "npm run fix-ts-jest && jest"
      }
    }
  }
~~~

testpack-cli versus package-preview
-----------------------------------

I created testpack because I wasn't happy with package-preview. Package-preview _does not_ create a special test folder and it _cannot_ edit the `import`/`require` commands in your source files. Instead, package-preview seems to be designed with the assumption that it will _always_ run before your tests. However, your package may need to be built (with Babel or TypeScript) before it is packaged, and package-preview installs it with a _separate copy_ of all the dependencies of your package. This is usually a slow process - a process you don't want to run _every time_ you run your unit tests.

For example, I wrote [a very simple package](https://www.npmjs.com/package/simplertime) whose unit tests took 1 second. Once I added package-preview, I needed 18 seconds to run package-preview before the unit tests could start.

Unfortunately, I couldn't find any way to import a module from *node_modules* if the path started with `./` - that prefix seems to be treated as proof that it's not in *node_modules*. Likewise, I couldn't find any way import a module from the current directory if it **did not** start with `./`. In normal JavaScript you could try using environment variables to figure out whether you need to use `.` or not, e.g. `require(process.env.TESTPACK ? "mymodule" : "./index")`. However if you are using TypeScript or `import` statements, this is not possible.

Thus, the purpose of `testpack` is to avoid slowing down the _normal_ unit test process when you are _not about to publish_. Your tests can import a local copy of your code from `./` or `../` so they run quickly. When you're ready to publish, you use the slower `testpack` process to create a special-purpose test environment with modified imports.

**Note:** I bet one of you JavaScript wizards knows how I could have avoided all this trouble with `./`. TypeScript users might think that [TypeScript aliases](https://stackoverflow.com/a/38677886/22820) could potentially solve this problem, but they can't because they are compile-time only. That is, if you tell TypeScript that `./A` is an alias for `B`, then TypeScript loads `B` for type checking but it generates code that still refers to `./A`! And [ts-node inherits this problem](https://github.com/TypeStrong/ts-node/issues/138); thus if you are writing code for the command line / Node.js, aliases don't seem to help at all.

Package-preview does have one special virtue: it uses `pnpm` to isolate the packed package (i.e. the almost-published tgz) from any other packages installed in the same project that are _not_ declared as dependencies in the packed package. Testpack doesn't have as much isolation, e.g. it keeps unit test frameworks. So, suppose that your packed package tries to use a dependency X but it doesn't declare the dependency in package.json like it should. If your unit test framework also uses dependency X, your code may still work when it should actually break. I apologize for that but I don't have time to implement fancier isolation. Perhaps someone will make a pull request?

Version history
---------------

### v1.1.2 ###

- Added `--setup-command` option.
- Changed how imports are transformed. Initially the prefix `./` or `../` or `../src` was simply stripped off, but in v1.1 `.` or `..` is replaced with the package name, and `src` is no longer treated specially.

### v1.0.3 ###

Initial release.

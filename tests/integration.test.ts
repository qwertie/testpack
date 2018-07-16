import * as fs from 'fs';
import * as path from 'path';
import * as tp from "../src/npm-testpack";

// This test changes ./yes to yes to prevent recursive operation
var insideTestFolder = './yes';
if (insideTestFolder !== 'yes') {
  test('Dress rehearsal', () => {
    var testFolder = "Dress rehearsal";
    expect(process.cwd()).not.toMatch(testFolder);

    var args = {
      "test-folder": testFolder,
      regex: "ts,js#insideTestFolder = '(./yes)'#", 
      clean: true,
      rmdir: true,
      verbose: true,
      install: ["ts-jest", "babel-core", "typescript"]
    };
    
    var opts = tp.refineOptions(args);
    process.env.CI = "true"; // CI mode changes Jest's output
    var result = tp.testPack(opts);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(testFolder, "tests/unit.test.ts"))).toBe(true);
    expect(fs.existsSync(path.join(testFolder, "tests/integration.test.ts"))).toBe(true);
  });
} else {
  test('Destruction test', () => {
    var opts = tp.refineOptions({ "test-folder": ".", verbose: false });
    expect(() => tp.testPack(opts)).toThrow(/test folder/);
  });
}

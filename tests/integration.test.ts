import * as fs from 'fs';
import * as path from 'path';
import * as tp from "..";

// Our package.json options change false to 'yes' to prevent recursive operation
var insideTestFolder = false;
if (insideTestFolder === false) {
  test('Dress rehearsal', () => {
    var testFolder = "Dress rehearsal";
    expect(process.cwd()).not.toMatch(testFolder);

    // Note: these options will be added to existing options in our package.json
    var args = {
      "test-folder": testFolder,
      "setup-command": "npm install",
      rmdir: true,
      verbose: true
    };
    
    var opts = tp.refineOptions(args);
    process.env.CI = "true"; // CI mode changes Jest's output
    
    var result = tp.testPack(opts);
    expect(result.status).toBe(0);

    expect(fs.existsSync(path.join(testFolder, "tests/unit.test.ts"))).toBe(true);
    expect(fs.existsSync(path.join(testFolder, "tests/integration.test.ts"))).toBe(true);
  });
} else {
  test('Custom replacement', () => {
    expect(insideTestFolder).toBe('yes');
  });
  test('Destruction test', () => {
    // Make sure we don't delete the test folder when it is set incorrectly
    var opts = tp.refineOptions({ "test-folder": ".", verbose: false });
    expect(() => tp.testPack(opts)).toThrow(/test folder/);
  });
}

import * as fs from 'fs';
import * as path from 'path';
import * as tp from "../src/npm-testpack";

var insideTestFolder = './yes';
if (insideTestFolder !== 'yes') {
  test('Dress rehearsal', () => {
    var testFolder = "Dress rehearsal";
    var args = {
      "test-folder": testFolder,
      nontest: '*testpack.ts', 
      regex: "ts,js#insideTestFolder = '(./yes)'#", 
      rmdir: true,
      verbose: true
    };
    console.log("ummm...");
    var opts = tp.refineOptions(args);
    console.log("ummm...");
    var result = tp.testPack(opts);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(testFolder, "tests/unit.test.ts"))).toBe(true);
    expect(fs.existsSync(path.join(testFolder, "tests/integration.test.ts"))).toBe(true);
  });
}

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseDesktopExport } from '../TelopotifyApp/src/core/desktopExport.ts';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/import-desktop-export.mjs <path-to-result.json>');
  process.exit(1);
}

try {
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const tracks = parseDesktopExport(input);
  const outputDir = resolve('local-data');
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'library.json');
  await writeFile(outputPath, JSON.stringify(tracks, null, 2), 'utf8');
  console.log(`Indexed ${tracks.length} audio messages into ${outputPath}`);
  const oversized = tracks.filter(track => track.fileSize !== null && track.fileSize > 20_000_000).length;
  const unknown = tracks.filter(track => track.fileSize === null).length;
  console.log(`${oversized} exceed the hosted Bot API's 20 MB download limit; ${unknown} have unknown size.`);
  console.log('Only metadata was imported; no audio files were downloaded.');
} catch (error) {
  console.error(`Import failed: ${error.message}`);
  process.exitCode = 1;
}

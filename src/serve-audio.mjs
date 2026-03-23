import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load once at cold-start, cached for all subsequent invocations
const audioBase64 = readFileSync(join(__dirname, 'waiting_sound.mp3')).toString('base64');

export const handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'audio/mpeg' },
  body: audioBase64,
  isBase64Encoded: true,
});

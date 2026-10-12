import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const EOF_MARKER = Buffer.from('%%EOF', 'latin1');

/**
 * Writes a byte-unique copy of the resume to `outPath`.
 *
 * Naukri ignores a re-upload it considers identical, so every run needs the
 * bytes to differ. We inject a PDF comment line immediately BEFORE the final
 * %%EOF rather than appending after it: comments are ignored by parsers, and
 * because the bytes land after both the xref table and the `startxref` offset
 * that points at it, no existing offset shifts. The file stays spec-valid and
 * ATS text extraction is untouched.
 *
 * The source is always the pristine base, so markers never accumulate.
 */
export async function buildUniqueResume(basePath, outPath) {
  const base = await readFile(basePath);

  if (!base.subarray(0, 5).equals(Buffer.from('%PDF-', 'latin1'))) {
    throw new Error(`${basePath} is not a PDF (missing %PDF- header)`);
  }

  const marker = Buffer.from(
    `% refresh ${new Date().toISOString()} ${randomUUID()}\n`,
    'latin1',
  );

  const eofAt = base.lastIndexOf(EOF_MARKER);
  const out =
    eofAt === -1
      ? // No trailer found — fall back to appending and let the reader cope.
        Buffer.concat([base, Buffer.from('\n', 'latin1'), marker])
      : Buffer.concat([base.subarray(0, eofAt), marker, base.subarray(eofAt)]);

  await writeFile(outPath, out);
  return { path: outPath, bytes: out.length };
}

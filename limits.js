function readLimit(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name} in .env`);
  }
  return value;
}

const maxPptxMiB = readLimit("MAX_PPTX_MIB");
const maxPdfMiB = readLimit("MAX_PDF_MIB");
const maxActiveTasks = readLimit("MAX_ACTIVE_TASKS");
const maxPptxEntries = readLimit("MAX_PPTX_ENTRIES");
const maxUncompressedMiB = readLimit("MAX_UNCOMPRESSED_MIB");
const conversionTimeoutSeconds = readLimit("CONVERSION_TIMEOUT_SECONDS");

module.exports = {
  maxPptxMiB,
  maxPdfMiB,
  maxActiveTasks,
  maxPptxEntries,
  conversionTimeoutSeconds,
  maxPptxBytes: maxPptxMiB * 1024 * 1024,
  maxPdfBytes: maxPdfMiB * 1024 * 1024,
  maxUncompressedBytes: maxUncompressedMiB * 1024 * 1024
};

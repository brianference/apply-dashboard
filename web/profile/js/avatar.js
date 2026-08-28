/**
 * Turning a chosen file into something small enough to store.
 *
 * A photo straight off a phone is several megabytes; the column caps at 200KB
 * of data URL and /api/auth/me reads that value on every page load, so the
 * resize happens HERE rather than being refused by the server after a long
 * upload. 256px square is what the header and the menu actually draw.
 */

/** What the avatar is drawn at, doubled so it stays sharp on a 2x screen. */
const SIZE = 256;
/** Start here and step down until the data URL fits. */
const QUALITIES = [0.85, 0.7, 0.55, 0.4];
const MAX_CHARS = 200000;

/**
 * Read a file into an image element.
 *
 * Through a data: URL, NOT URL.createObjectURL. The page's Content-Security-
 * Policy is `img-src 'self' data:`, and a blob: URL is neither of those, so the
 * browser refused to load the image and the only thing the person saw was
 * "That file could not be read as an image" - which blamed their file for a
 * policy decision. data: is already permitted, so nothing has to be widened.
 *
 * @param {File} file
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That file could not be read from disk."));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That file could not be decoded as an image. PNG, JPEG and WEBP work."));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Centre-crop to a square and scale to SIZE, then encode as JPEG.
 *
 * Cropping rather than squashing: a portrait photo squeezed into a circle looks
 * wrong in a way people notice immediately on their own face.
 *
 * @param {File} file
 * @returns {Promise<string>} a data URL under the size cap
 */
export async function toAvatarDataUrl(file) {
  if (!file || !/^image\//.test(file.type)) {
    throw new Error("Choose an image file.");
  }
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = Math.round((img.naturalWidth - side) / 2);
  const sy = Math.round((img.naturalHeight - side) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);

  for (const quality of QUALITIES) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= MAX_CHARS) return url;
  }
  throw new Error("That image could not be compressed small enough. Try a smaller one.");
}

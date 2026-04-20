import assetManager from './assetManager';

const pool = [];
const checkedOut = new Set();

let maxWidth = 0;
let maxHeight = 0;

function reallocateIfNeeded(width, height, canvas) {
  if (maxWidth < width) {
    maxWidth = width;
  }
  if (maxHeight < height) {
    maxHeight = height;
  }
  if (canvas.width < maxWidth || canvas.height < maxHeight) {
    canvas.width = maxWidth;
    canvas.height = maxHeight;
  }
}

function allocate(width, height) {
  const canvas = pool.length ? pool.pop() : assetManager.createCanvas(width, height);
  reallocateIfNeeded(width, height, canvas);
  checkedOut.add(canvas);
  return canvas;
}

function release(canvas) {
  checkedOut.delete(canvas);
  pool.push(canvas);
}

function releaseAll() {
  checkedOut.forEach((canvas) => {
    pool.push(canvas);
  });
  checkedOut.clear();
}

const bufferManager = {
  allocate,
  release,
  releaseAll,
};

export default bufferManager;

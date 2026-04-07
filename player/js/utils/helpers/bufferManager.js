import assetManager from './assetManager';

const pool = [];
const checkedOut = new Set();

let maxWidth = 0;
let maxHeight = 0;

function reallocate() {
  for (let i = 0; i < pool.length; i += 1) {
    const canvas = pool[i];
    if (canvas.width < maxWidth) {
      canvas.width = maxWidth;
    }
    if (canvas.height < maxHeight) {
      canvas.height = maxHeight;
    }
  }
}

function reallocateIfNeeded(width, height) {
  let needsReallocation = false;
  if (maxWidth < width) {
    maxWidth = width;
    needsReallocation = true;
  }
  if (maxHeight < height) {
    maxHeight = height;
    needsReallocation = true;
  }
  if (needsReallocation) {
    reallocate();
  }
}

function allocate(width, height) {
  reallocateIfNeeded(width, height);
  const canvas = pool.length ? pool.pop() : assetManager.createCanvas(width, height);
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

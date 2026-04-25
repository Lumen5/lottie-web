// Path → triangle tessellation for the native WebGL renderer.
//
// flattenPath:
//   Converts a sequence of recorded 2D path commands (moveTo/lineTo/
//   bezierCurveTo/closePath) into one or more flat polylines (subpaths).
//
// triangulatePolygon:
//   Ear-clipping triangulation for a single (simple, non-self-intersecting)
//   closed polygon.  Multi-subpath holes are not supported — each subpath
//   is tessellated independently.
//
// buildStrokeGeometry:
//   Generates triangle geometry for a stroke by extruding quads along each
//   line segment.  Joins are simple miter/overlap; caps are butt.  Good
//   enough for the common Lottie cases without heavy geometry code.

var BEZIER_SEGMENTS = 16;

function flattenBezier(out, x0, y0, cp1x, cp1y, cp2x, cp2y, x1, y1) {
  for (var i = 1; i <= BEZIER_SEGMENTS; i += 1) {
    var t = i / BEZIER_SEGMENTS;
    var mt = 1 - t;
    var mt2 = mt * mt;
    var t2 = t * t;
    var x = mt2 * mt * x0 + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t2 * t * x1;
    var y = mt2 * mt * y0 + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t2 * t * y1;
    out.push(x, y);
  }
}

// commands: array of { op, args } where op is 'M' | 'L' | 'C' | 'Z'
// Returns array of subpaths, each a Float64Array-like array of [x0,y0,x1,y1,...]
function flattenPath(commands) {
  var subpaths = [];
  var current = null;
  var startX = 0;
  var startY = 0;
  var prevX = 0;
  var prevY = 0;
  for (var i = 0; i < commands.length; i += 1) {
    var cmd = commands[i];
    var args = cmd.args;
    if (cmd.op === 'M') {
      if (current && current.length >= 4) {
        subpaths.push(current);
      }
      current = [];
      startX = args[0];
      startY = args[1];
      current.push(startX, startY);
      prevX = startX;
      prevY = startY;
    } else if (cmd.op === 'L') {
      if (!current) {
        current = [];
        startX = args[0];
        startY = args[1];
        prevX = startX;
        prevY = startY;
        current.push(startX, startY);
      } else {
        current.push(args[0], args[1]);
        prevX = args[0];
        prevY = args[1];
      }
    } else if (cmd.op === 'C') {
      if (!current) {
        current = [];
        current.push(prevX, prevY);
      }
      flattenBezier(current, prevX, prevY, args[0], args[1], args[2], args[3], args[4], args[5]);
      prevX = args[4];
      prevY = args[5];
    } else if (cmd.op === 'Z') {
      if (current && current.length >= 4) {
        // Close: connect last point back to start (no need to push the start again
        // — the triangulator treats the polygon as closed implicitly).
        subpaths.push(current);
      }
      current = null;
    }
  }
  if (current && current.length >= 4) {
    subpaths.push(current);
  }
  return subpaths;
}

function polygonArea(verts) {
  var area = 0;
  var n = verts.length / 2;
  for (var i = 0; i < n; i += 1) {
    var j = (i + 1) % n;
    area += verts[i * 2] * verts[j * 2 + 1];
    area -= verts[j * 2] * verts[i * 2 + 1];
  }
  return area * 0.5;
}

function triangleArea(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  var d1 = triangleArea(px, py, ax, ay, bx, by);
  var d2 = triangleArea(px, py, bx, by, cx, cy);
  var d3 = triangleArea(px, py, cx, cy, ax, ay);
  var hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  var hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

// Triangulate a single closed polygon by ear-clipping.
// Returns flat array of triangle vertices [x0,y0,x1,y1,x2,y2, ...] (each tri = 6 floats).
function triangulatePolygon(verts) {
  var n = verts.length / 2;
  if (n < 3) return [];
  // Make a working copy; ensure CCW orientation so "convex" check uses
  // a consistent sign.  If CW, reverse.
  var pts = new Array(n * 2);
  if (polygonArea(verts) < 0) {
    for (var k = 0; k < n; k += 1) {
      pts[k * 2] = verts[(n - 1 - k) * 2];
      pts[k * 2 + 1] = verts[(n - 1 - k) * 2 + 1];
    }
  } else {
    for (var m = 0; m < n * 2; m += 1) pts[m] = verts[m];
  }

  var indices = [];
  for (var i = 0; i < n; i += 1) indices.push(i);

  var out = [];
  var watchdog = n * n;
  while (indices.length > 3 && watchdog > 0) {
    watchdog -= 1;
    var earFound = false;
    for (var idx = 0; idx < indices.length; idx += 1) {
      var prev = indices[(idx - 1 + indices.length) % indices.length];
      var curr = indices[idx];
      var next = indices[(idx + 1) % indices.length];
      var ax = pts[prev * 2];
      var ay = pts[prev * 2 + 1];
      var bx = pts[curr * 2];
      var by = pts[curr * 2 + 1];
      var cx = pts[next * 2];
      var cy = pts[next * 2 + 1];
      // Convex check (CCW polygon → cross > 0).
      if (triangleArea(ax, ay, bx, by, cx, cy) > 0) {
        var anyInside = false;
        for (var p = 0; p < indices.length; p += 1) {
          var ip = indices[p];
          if (ip !== prev && ip !== curr && ip !== next) {
            var px = pts[ip * 2];
            var py = pts[ip * 2 + 1];
            if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) {
              anyInside = true;
              break;
            }
          }
        }
        if (!anyInside) {
          out.push(ax, ay, bx, by, cx, cy);
          indices.splice(idx, 1);
          earFound = true;
          break;
        }
      }
    }
    if (!earFound) break;
  }
  if (indices.length === 3) {
    out.push(
      pts[indices[0] * 2], pts[indices[0] * 2 + 1],
      pts[indices[1] * 2], pts[indices[1] * 2 + 1],
      pts[indices[2] * 2], pts[indices[2] * 2 + 1]
    );
  }
  return out;
}

// Generate triangle geometry for a stroked polyline.
//   verts: flat array [x0,y0,...]; closed: whether it loops back to start.
//   width: stroke width (full width, not half).
// Joins are simple per-segment quads with a small overlap; caps are butt.
function buildStrokeGeometry(verts, closed, width) {
  var out = [];
  var n = verts.length / 2;
  if (n < 2 || width <= 0) return out;
  var halfW = width * 0.5;
  var segCount = closed ? n : n - 1;
  for (var i = 0; i < segCount; i += 1) {
    var i0 = i;
    var i1 = (i + 1) % n;
    var x0 = verts[i0 * 2];
    var y0 = verts[i0 * 2 + 1];
    var x1 = verts[i1 * 2];
    var y1 = verts[i1 * 2 + 1];
    var dx = x1 - x0;
    var dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) {
      // Skip degenerate segments.
    } else {
      var nx = (-dy / len) * halfW;
      var ny = (dx / len) * halfW;
      var ax = x0 + nx;
      var ay = y0 + ny;
      var bx = x0 - nx;
      var by = y0 - ny;
      var cx = x1 - nx;
      var cy = y1 - ny;
      var dx2 = x1 + nx;
      var dy2 = y1 + ny;
      out.push(ax, ay, bx, by, dx2, dy2);
      out.push(bx, by, cx, cy, dx2, dy2);
    }
  }
  return out;
}

export {
  flattenPath,
  triangulatePolygon,
  buildStrokeGeometry,
};

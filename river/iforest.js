'use strict';
/*
 * ISOLATION FOREST (Liu, Ting & Zhou, 2008) — implementación propia, sin
 * librerías. Idea: las anomalías son FÁCILES DE AISLAR. Construye árboles que
 * parten el espacio al azar; un punto raro queda aislado con pocos cortes
 * (camino corto), uno normal necesita muchos (camino largo). La puntuación de
 * anomalía es ~1 para caminos cortos, ~0.5 para normales.
 */

// PRNG determinista
function makeRng(seed = 42) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

// c(n): longitud media de camino en un árbol binario de búsqueda con n puntos
// (factor de normalización del paper).
function cFactor(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649015329) - (2 * (n - 1)) / n;
}

// Construye un iTree sobre un subconjunto de vectores (índices de X).
function buildTree(X, idx, depth, maxDepth, rng, dim) {
  if (depth >= maxDepth || idx.length <= 1) return { leaf: true, size: idx.length };
  const q = Math.floor(rng() * dim);
  let min = Infinity, max = -Infinity;
  for (const i of idx) { const v = X[i][q]; if (v < min) min = v; if (v > max) max = v; }
  if (min === max) return { leaf: true, size: idx.length };
  const p = min + rng() * (max - min);
  const L = [], R = [];
  for (const i of idx) (X[i][q] < p ? L : R).push(i);
  return { q, p, left: buildTree(X, L, depth + 1, maxDepth, rng, dim), right: buildTree(X, R, depth + 1, maxDepth, rng, dim) };
}

// Longitud de camino de un vector x en un árbol.
function pathLength(x, node, depth) {
  while (!node.leaf) { node = x[node.q] < node.p ? node.left : node.right; depth++; }
  return depth + cFactor(node.size);
}

class IsolationForest {
  /** @param {object} o nTrees (100), sampleSize ψ (256), seed */
  constructor({ nTrees = 100, sampleSize = 256, seed = 42 } = {}) {
    this.nTrees = nTrees; this.psi = sampleSize; this.rng = makeRng(seed); this.trees = [];
  }
  /** Entrena sobre una matriz de vectores X (n×d). Sin etiquetas. */
  fit(X) {
    const n = X.length, dim = X[0].length, psi = Math.min(this.psi, n);
    const maxDepth = Math.ceil(Math.log2(Math.max(psi, 2)));
    this.cPsi = cFactor(psi);
    this.dim = dim;
    this.trees = [];
    for (let t = 0; t < this.nTrees; t++) {
      const idx = []; for (let k = 0; k < psi; k++) idx.push(Math.floor(this.rng() * n));
      this.trees.push(buildTree(X, idx, 0, maxDepth, this.rng, dim));
    }
    return this;
  }
  /** Puntuación de anomalía de un vector: ~1 anómalo, ~0.5 normal. */
  score(x) {
    let sum = 0; for (const tr of this.trees) sum += pathLength(x, tr, 0);
    const Eh = sum / this.trees.length;
    return Math.pow(2, -Eh / this.cPsi);
  }
}

module.exports = { IsolationForest };

// Recursive backtracking (DFS) maze generator.
// Produces a grid of size (cols*2+1) x (rows*2+1) where cells live on odd indices
// and walls on even indices. 0 = path, 1 = wall.

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateMaze(cols = 10, rows = 10) {
  const W = cols * 2 + 1;
  const H = rows * 2 + 1;
  const grid = Array.from({ length: H }, () => Array(W).fill(1));
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));

  // Iterative DFS to avoid stack overflow for larger mazes.
  const stack = [[0, 0]];
  visited[0][0] = true;
  grid[1][1] = 0;

  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const dirs = shuffle(DIRS.slice());
    let advanced = false;

    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      if (visited[ny][nx]) continue;

      // Carve the wall between current and next cell, plus the next cell itself.
      grid[cy * 2 + 1 + dy][cx * 2 + 1 + dx] = 0;
      grid[ny * 2 + 1][nx * 2 + 1] = 0;
      visited[ny][nx] = true;
      stack.push([nx, ny]);
      advanced = true;
      break;
    }

    if (!advanced) stack.pop();
  }

  return {
    grid,
    width: W,
    height: H,
    start: { x: 1, y: 1 },
    goal: { x: W - 2, y: H - 2 },
  };
}

module.exports = { generateMaze };

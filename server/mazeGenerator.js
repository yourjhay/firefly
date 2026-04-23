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

  const { start, goal } = pickStartAndGoal(grid, W, H, cols, rows);

  return {
    grid,
    width: W,
    height: H,
    start,
    goal,
  };
}

// Picks a random carved cell as the start, then BFS from it to find the set of
// cells near the maze's diameter. The goal is sampled from that "far" set so
// every round still feels like a real race while both endpoints vary.
function pickStartAndGoal(grid, W, H, cols, rows) {
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push([c * 2 + 1, r * 2 + 1]);
    }
  }

  const [sx, sy] = cells[Math.floor(Math.random() * cells.length)];

  const dist = Array.from({ length: H }, () => Array(W).fill(-1));
  dist[sy][sx] = 0;
  const queue = [[sx, sy]];
  let head = 0;
  let maxDist = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++];
    const d = dist[y][x];
    if (d > maxDist) maxDist = d;
    for (let i = 0; i < 4; i++) {
      const dx = [1, -1, 0, 0][i];
      const dy = [0, 0, 1, -1][i];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (grid[ny][nx] === 1) continue;
      if (dist[ny][nx] !== -1) continue;
      dist[ny][nx] = d + 1;
      queue.push([nx, ny]);
    }
  }

  // Candidates within 20% of the diameter — preserves a long race while
  // giving the goal position some variety instead of a single fixed corner.
  const threshold = Math.max(1, Math.floor(maxDist * 0.8));
  const farCells = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (dist[y][x] >= threshold) farCells.push([x, y]);
    }
  }
  const [gx, gy] = farCells[Math.floor(Math.random() * farCells.length)];

  return {
    start: { x: sx, y: sy },
    goal: { x: gx, y: gy },
  };
}

module.exports = { generateMaze };

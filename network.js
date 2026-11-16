(() => {
  const tau = Math.PI * 2;
  const mix = (start, end, fraction) => start + (end - start) * fraction;

  function normalize([x, y, z]) {
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  }

  function makeGlobe() {
    const phi = (1 + Math.sqrt(5)) / 2;
    const vertices = [
      [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
      [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
      [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
    ].map(normalize);
    let faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    const edgeKey = (a, b) => Math.min(a, b) + ':' + Math.max(a, b);

    for (let subdivision = 0; subdivision < 2; subdivision += 1) {
      const subdivisions = new Map();
      function midpoint(a, b) {
        const key = edgeKey(a, b);
        if (!subdivisions.has(key)) {
          const halfway = vertices[a].map((coordinate, axis) => coordinate + vertices[b][axis]);
          subdivisions.set(key, vertices.push(normalize(halfway)) - 1);
        }
        return subdivisions.get(key);
      }
      faces = faces.flatMap(([a, b, c]) => {
        const ab = midpoint(a, b);
        const bc = midpoint(b, c);
        const ca = midpoint(c, a);
        return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
      });
    }

    const edges = new Map();
    for (const [a, b, c] of faces) {
      edges.set(edgeKey(a, b), [a, b]);
      edges.set(edgeKey(b, c), [b, c]);
      edges.set(edgeKey(c, a), [c, a]);
    }
    return { vertices, edges: [...edges.values()] };
  }

  const globe = makeGlobe();
  const meshOpacity = [0.13, 0.20, 0.30, 0.40, 0.53];
  const orbitBands = [
    { tilt: 0.48, width: 1.4, height: 0.58, phase: 0.12 },
    { tilt: -0.75, width: 1.33, height: 0.64, phase: 2.03 },
    { tilt: 0.99, width: 1.16, height: 0.71, phase: 3.29 },
  ];

  function curve(start, end, bend) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    return {
      start,
      controlA: { x: start.x + dx * 0.32 + nx * bend, y: start.y + dy * 0.19 + ny * bend },
      controlB: { x: end.x - dx * 0.26 + nx * bend, y: end.y - dy * 0.21 + ny * bend },
      end,
    };
  }

  function pointOnCurve(path, position) {
    const t = position;
    const u = 1 - t;
    const { start, controlA, controlB, end } = path;
    return {
      x: u ** 3 * start.x + 3 * u ** 2 * t * controlA.x + 3 * u * t ** 2 * controlB.x + t ** 3 * end.x,
      y: u ** 3 * start.y + 3 * u ** 2 * t * controlA.y + 3 * u * t ** 2 * controlB.y + t ** 3 * end.y,
    };
  }

  function sampleCurve(start, end, bend) {
    const path = curve(start, end, bend);
    return Array.from({ length: 17 }, (_, index) => pointOnCurve(path, index / 16));
  }

  function nodePort(node, toward) {
    if (!node.width || !node.height) return node;
    const dx = toward.x - node.x;
    const dy = toward.y - node.y;
    if (!dx && !dy) return node;
    const scale = Math.min(
      (node.width / 2 + 2) / Math.abs(dx),
      (node.height / 2 + 2) / Math.abs(dy),
    );
    return { x: node.x + dx * scale, y: node.y + dy * scale };
  }

  function globePoint(center, radius, angle) {
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  }

  function globeAngle(center, point) {
    return Math.atan2(point.y - center.y, point.x - center.x);
  }

  function completionLeg(center, node, completed) {
    const exit = nodePort(node, completed);
    return sampleCurve(exit, completed, center.r * 0.24);
  }

  function createTransferPath(layout, transfer) {
    const { center, nodes, pool, completed, coreRadius = center.r * 0.46 } = layout;
    const target = nodes[transfer.to];
    if (!target) return null;

    const sourceNode = nodes[transfer.from];
    const source = sourceNode || pool || globePoint(center, center.r * 1.21, Math.PI + 0.56);
    const destinationAngle = globeAngle(center, target);
    const sourceAngle = globeAngle(center, source) + (sourceNode ? 0 : 0.38);
    const orbitRadius = Math.max(center.r * 0.81, Math.min(center.r * 0.97, coreRadius + 24));
    const orbitStart = globePoint(center, orbitRadius, sourceAngle);
    const orbitEnd = globePoint(center, orbitRadius, destinationAngle);
    const ingress = sampleCurve(nodePort(source, orbitStart), orbitStart, sourceNode ? 0 : -center.r * 0.29);

    let sweep = Math.atan2(Math.sin(destinationAngle - sourceAngle), Math.cos(destinationAngle - sourceAngle));
    if (transfer.from === transfer.to) sweep = tau;
    const orbit = Array.from({ length: 37 }, (_, index) =>
      globePoint(center, orbitRadius, sourceAngle + sweep * index / 36),
    );
    const egress = sampleCurve(orbitEnd, nodePort(target, orbitEnd), center.r * 0.12);
    const points = [...ingress, ...orbit.slice(1), ...egress.slice(1)];

    if (transfer.completed && completed) {
      // The intermediate points across the card are beneath its opaque surface.
      points.push(...completionLeg(center, target, completed));
    }

    let length = 0;
    const distances = points.map((point, index) => {
      if (index) {
        const previous = points[index - 1];
        length += Math.hypot(point.x - previous.x, point.y - previous.y);
      }
      return length;
    });
    return { points, distances, length };
  }

  function pathPoint(path, distance) {
    const end = path.distances.findIndex((value) => value >= distance);
    if (end <= 0) return path.points[end === 0 ? 0 : path.points.length - 1];
    const start = end - 1;
    const interval = path.distances[end] - path.distances[start];
    const offset = interval ? (distance - path.distances[start]) / interval : 0;
    return {
      x: mix(path.points[start].x, path.points[end].x, offset),
      y: mix(path.points[start].y, path.points[end].y, offset),
    };
  }

  function drawPolyline(context, points, color, width) {
    context.lineWidth = width;
    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }

  function drawTransfer(context, path, transfer) {
    const { completed, tone } = transfer;
    const progress = Math.max(0, Math.min(1, transfer.progress));
    const distance = progress * path.length;
    const point = pathPoint(path, distance);
    const fading = Math.min(1, 0.32 + progress * 7, 0.58 + (1 - progress) * 7);
    const colors = completed ? '148, 250, 192' : tone === 'ambient' ? '184, 218, 226' : '238, 253, 255';
    const trailLength = Math.min(133, Math.max(64, path.length * 0.19));
    const trail = Array.from({ length: 23 }, (_, index) =>
      pathPoint(path, Math.max(0, distance - trailLength * (1 - index / 22))),
    );

    drawPolyline(context, path.points, `rgba(${colors}, ${tone === 'ambient' ? 0.18 : 0.30})`, 1.1);

    for (let start = 0; start < 22; start += 1) {
      const strength = fading * (start + 1) / 22;
      const segment = [trail[start], trail[start + 1]];
      drawPolyline(context, segment, `rgba(${colors}, ${strength * 0.18})`, 8.5);
      drawPolyline(context, segment, `rgba(${colors}, ${strength * 0.98})`, 2.15);
    }

    drawDot(context, point.x, point.y, 11, `rgba(${colors}, ${fading * 0.13})`);
    drawDot(context, point.x, point.y, 6.3, `rgba(${colors}, ${fading * 0.35})`);
    drawDot(context, point.x, point.y, 3.1, `rgba(${colors}, ${fading})`);
    return { ...point, id: transfer.id, tone, completed };
  }

  function drawCurve(context, path, color, offset = 0) {
    const { start, controlA, controlB, end } = path;
    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(start.x, start.y + offset * 0.5);
    context.bezierCurveTo(
      controlA.x, controlA.y + offset,
      controlB.x, controlB.y + offset,
      end.x, end.y + offset * 0.5,
    );
    context.stroke();
  }

  function drawDot(context, x, y, radius, color) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, radius, 0, tau);
    context.fill();
  }

  function drawOrbits(context, center, elapsed) {
    for (const band of orbitBands) {
      const width = center.r * band.width;
      const height = center.r * band.height;
      const angle = band.tilt;
      context.strokeStyle = 'rgba(222, 228, 229, 0.21)';
      context.beginPath();
      context.ellipse(center.x, center.y, width, height, angle, 0, tau);
      context.stroke();

      const phase = band.phase + elapsed * 0.38;
      const x = width * Math.cos(phase);
      const y = height * Math.sin(phase);
      drawDot(
        context,
        center.x + x * Math.cos(angle) - y * Math.sin(angle),
        center.y + x * Math.sin(angle) + y * Math.cos(angle),
        1.65,
        'rgba(241, 244, 243, 0.77)',
      );
    }
  }

  function drawGlobe(context, center, elapsed) {
    const yaw = -0.19 + elapsed * 0.24;
    const pitch = -0.33 + Math.sin(elapsed * 0.17) * 0.09;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const points = globe.vertices.map(([x, y, z]) => {
      const depth = z * cosYaw - x * sinYaw;
      return {
        x: center.x + (x * cosYaw + z * sinYaw) * center.r,
        y: center.y + (y * cosPitch - depth * sinPitch) * center.r,
        z: y * sinPitch + depth * cosPitch,
      };
    });

    context.strokeStyle = 'rgba(228, 231, 229, 0.19)';
    context.beginPath();
    context.arc(center.x, center.y, center.r, 0, tau);
    context.stroke();

    const bands = meshOpacity.map(() => []);
    for (const [a, b] of globe.edges) {
      const depth = (points[a].z + points[b].z) / 2;
      const band = Math.min(bands.length - 1, Math.floor((depth + 1) * 2.5));
      bands[band].push([points[a], points[b]]);
    }

    bands.forEach((edges, index) => {
      context.strokeStyle = 'rgba(210, 218, 220, ' + meshOpacity[index] + ')';
      context.beginPath();
      for (const [start, end] of edges) {
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
      }
      context.stroke();
    });

    for (let index = 0; index < points.length; index += 7) {
      const { x, y, z } = points[index];
      const flash = Math.sin(elapsed * 1.9 + index * 2.4) * 0.12;
      const opacity = mix(0.15, 0.72, (z + 1) / 2) + flash;
      drawDot(context, x, y, z > 0.45 ? 1.4 : 0.9, 'rgba(240, 242, 241, ' + opacity + ')');
    }
  }

  function drawNodes(context, center, nodes, activeNode, elapsed) {
    const routes = [];
    nodes.forEach((node, index) => {
      if (!node) return;
      const { x, y } = node;
      const bend = center.r * (x < center.x ? 0.26 : -0.26) * (y >= center.y ? 1 : -1);
      const route = curve(center, node, bend);
      routes[index] = route;
      const active = index === activeNode || node.active;
      const tint = active ? 'rgba(202, 210, 212, 0.36)' : 'rgba(202, 210, 212, 0.15)';
      drawCurve(context, route, tint);
      drawCurve(context, route, 'rgba(202, 210, 212, 0.12)', -5);
      drawCurve(context, route, 'rgba(202, 210, 212, 0.12)', 5);
      if (!active) return;

      for (let particle = 0; particle < 3; particle += 1) {
        const t = 0.44 + 0.49 * ((elapsed * 0.64 + index * 0.13 + particle / 3) % 1);
        const head = pointOnCurve(route, t);
        const tail = pointOnCurve(route, t - 0.035);
        context.strokeStyle = particle === 0 ? 'rgba(247, 250, 249, 0.86)' : 'rgba(224, 232, 232, 0.50)';
        context.beginPath();
        context.moveTo(tail.x, tail.y);
        context.lineTo(head.x, head.y);
        context.stroke();
      }
    });
    return routes;
  }

  class DispatchNetwork {
    constructor(canvas, getLayout, onPacketPosition) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d');
      this.getLayout = getLayout;
      this.onPacketPosition = onPacketPosition;
      this.packetPosition = null;
      this.motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.elapsed = 0;
      this.previousFrame = null;
      this.lastDraw = null;
      this.transferPath = null;
      this.size = { width: 0, height: 0 };
      this.observer = new ResizeObserver(([entry]) => {
        this.size = entry.contentRect;
      });
      this.observer.observe(canvas);
      this.frame = this.frame.bind(this);
      this.animationFrame = requestAnimationFrame(this.frame);
    }

    frame(timestamp) {
      const { context, canvas } = this;
      const { width, height } = this.size;
      const layout = this.getLayout();

      const rotating = layout?.playing && !this.motion.matches;
      if (rotating && this.previousFrame !== null) {
        this.elapsed += Math.min(0.05, (timestamp - this.previousFrame) / 1000);
      }
      this.previousFrame = timestamp;

      if (context && layout && width && height) {
        const scale = Math.min(2, window.devicePixelRatio || 1);
        const pixelWidth = Math.round(width * scale);
        const pixelHeight = Math.round(height * scale);
        const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
        const last = this.lastDraw;
        const transfer = layout.transfer;
        const changed = !last || last.center !== layout.center || last.nodes !== layout.nodes ||
          last.activeNode !== layout.activeNode || last.progress !== layout.progress ||
          last.playing !== layout.playing || last.transfer?.id !== transfer?.id ||
          last.transfer?.progress !== transfer?.progress || last.transfer?.from !== transfer?.from ||
          last.transfer?.to !== transfer?.to || last.transfer?.completed !== transfer?.completed ||
          last.transfer?.tone !== transfer?.tone;
        if (resized) {
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
        }
        if (rotating || resized || changed) {
          context.setTransform(scale, 0, 0, scale, 0, 0);
          context.clearRect(0, 0, width, height);
          context.lineWidth = 0.85;
          context.lineCap = 'round';
          this.packetPosition = null;
          this.draw(layout);
          this.onPacketPosition?.(this.packetPosition);
          this.lastDraw = layout;
        }
      }

      this.animationFrame = requestAnimationFrame(this.frame);
    }

    draw(layout) {
      const { nodes, center, pool, activity, completed, activeNode, progress, transfer } = layout;
      if (!center || center.r <= 0) return;
      const { context, elapsed } = this;
      const inbound = pool && curve(pool, center, -center.r * 0.14);
      if (inbound) drawCurve(context, inbound, 'rgba(202, 210, 212, 0.32)');
      if (activity) {
        const outbound = curve(center, activity, center.r * 0.09);
        drawCurve(context, outbound, 'rgba(202, 210, 212, 0.12)');
      }

      if (completed && nodes[3]) {
        drawPolyline(context, completionLeg(center, nodes[3], completed), 'rgba(148, 230, 181, 0.27)', 0.85);
      }

      const routes = drawNodes(context, center, nodes, activeNode, elapsed);
      drawOrbits(context, center, elapsed);
      drawGlobe(context, center, elapsed);

      if (transfer && Number.isFinite(transfer.progress)) {
        const cached = this.transferPath;
        const key = [transfer.from, transfer.to, transfer.completed].join(':');
        if (!cached || cached.center !== center || cached.nodes !== nodes || cached.pool !== pool ||
            cached.completed !== completed || cached.key !== key) {
          this.transferPath = { center, nodes, pool, completed, key, path: createTransferPath(layout, transfer) };
        }
        const path = this.transferPath.path;
        if (path?.length) this.packetPosition = drawTransfer(context, path, transfer);
        return;
      }

      const target = routes[activeNode];
      if (!target || !Number.isFinite(progress)) return;
      const t = Math.max(0, Math.min(1, progress));
      const route = inbound && t < 0.49 ? inbound : target;
      const position = !inbound ? t : t < 0.49 ? t / 0.49 : (t - 0.49) / 0.51;
      this.packetPosition = pointOnCurve(route, position);
      const { x, y } = this.packetPosition;
      drawDot(context, x, y, 6.5, 'rgba(245, 250, 249, 0.12)');
      drawDot(context, x, y, 2.6, 'rgba(255, 255, 255, 0.96)');
    }

    destroy() {
      cancelAnimationFrame(this.animationFrame);
      this.observer.disconnect();
    }
  }

  window.DispatchNetwork = DispatchNetwork;
})();

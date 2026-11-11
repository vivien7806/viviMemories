const MAX_ZOOM = 8;
const WHEEL_SPEED = 0.0018;

/* Zoom à la molette (le point sous le curseur reste immobile), déplacement au glisser,
   remise à zéro au double-clic. onZoomed(level, changedMode) : changedMode quand on entre
   dans le zoom ou qu'on en sort, ce qui met en pause ou relance la minuterie des photos. */
export class Zoom {
  level = 1;
  private x = 0;
  private y = 0;
  private drag: { x: number; y: number } | null = null;

  constructor(
    private stage: HTMLElement,
    private target: () => HTMLElement | null,
    private onZoomed: (level: number, changedMode: boolean) => void,
  ) {
    stage.addEventListener('wheel', e => this.wheel(e), { passive: false });
    stage.addEventListener('mousedown', e => this.grab(e));
    stage.addEventListener('dblclick', () => this.set(1));
    window.addEventListener('mousemove', e => this.move(e));
    window.addEventListener('mouseup', () => this.release());
  }

  get active() { return this.level > 1; }

  // Nouveau média à l'écran : sans zoom, sans laisser de transformation.
  reset(node: HTMLElement) {
    this.level = 1;
    this.x = this.y = 0;
    this.stage.classList.remove('zoomed');
    node.style.transform = node.style.cursor = '';
  }

  set(level: number, cx = 0, cy = 0) {
    const before = this.level;
    this.level = Math.min(MAX_ZOOM, Math.max(1, level));
    this.x -= cx * (this.level - before);
    this.y -= cy * (this.level - before);
    if (this.level === 1) this.x = this.y = 0;
    this.stage.classList.toggle('zoomed', this.active);
    this.apply();
    this.onZoomed(this.level, (before > 1) !== this.active);
  }

  private apply() {
    const node = this.target();
    if (node) node.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.level})`;
  }

  private wheel(e: WheelEvent) {
    const node = this.target();
    if (!node) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    this.set(this.level - e.deltaY * WHEEL_SPEED * this.level,
      (e.clientX - r.left - r.width / 2) / this.level,
      (e.clientY - r.top - r.height / 2) / this.level);
  }

  private grab(e: MouseEvent) {
    const node = this.target();
    if (!this.active || !node) return;
    e.preventDefault();
    this.drag = { x: e.clientX - this.x, y: e.clientY - this.y };
    node.style.cursor = 'grabbing';
  }

  private move(e: MouseEvent) {
    if (!this.drag) return;
    this.x = e.clientX - this.drag.x;
    this.y = e.clientY - this.drag.y;
    this.apply();
  }

  private release() {
    const node = this.target();
    if (this.drag && node) node.style.cursor = '';
    this.drag = null;
  }
}

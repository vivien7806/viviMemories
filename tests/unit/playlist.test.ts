import { describe, expect, it } from 'vitest';
import { Playlist } from '../../src/renderer/playlist';
import type { Media } from '../../src/renderer/platform';

const media = (name: string, date: string): Media =>
  ({ name, path: name, type: /\.(jpg|png)$/.test(name) ? 'image' : 'video', date: new Date(date), converted: null });

// Volontairement dans le désordre : la playlist trie par date.
const folder = () => [
  media('c.mp4', '2020-03-01T10:00'),
  media('a.jpg', '2020-01-01T10:00'),
  media('e.mp4', '2020-05-01T10:00'),
  media('b.jpg', '2020-02-01T10:00'),
  media('d.jpg', '2020-04-01T10:00'),
];
const names = (list: readonly Media[]) => list.map(m => m.name);

function loaded(found = folder()) {
  const p = new Playlist();
  p.load(found);
  return p;
}

describe('Playlist', () => {
  it('trie par date et parcourt en boucle', () => {
    const p = loaded();
    expect(names(p.items)).toEqual(['a.jpg', 'b.jpg', 'c.mp4', 'd.jpg', 'e.mp4']);
    expect(p.prev()?.name).toBe('e.mp4');
    expect(p.next()?.name).toBe('a.jpg');
  });

  it('précharge dans le sens de navigation', () => {
    const p = loaded();
    p.goTo(2);
    expect(names(p.ahead())).toEqual(['d.jpg', 'e.mp4', 'b.jpg']);
    p.prev();
    expect(names(p.ahead())).toEqual(['a.jpg', 'e.mp4', 'c.mp4']);
    expect(names([...p.window()]).sort()).toEqual(['a.jpg', 'b.jpg', 'c.mp4', 'e.mp4']);
  });

  it('reste sûre une fois vide', () => {
    const p = loaded([]);
    expect(p.current).toBeUndefined();
    expect(p.ahead()).toEqual([]);
    expect(p.window().size).toBe(0);
  });

  it('ramène un numéro hors limites', () => {
    const p = loaded();
    expect(p.goToNumber(3)).toEqual({ clamped: false });
    expect(p.current?.name).toBe('c.mp4');
    expect(p.goToNumber(99)).toEqual({ clamped: true });
    expect(p.current?.name).toBe('e.mp4');
    expect(p.goToNumber(0)).toEqual({ clamped: true });
    expect(p.current?.name).toBe('a.jpg');
  });

  it('va au premier média d’une date', () => {
    const p = loaded();
    expect(p.goToDate(new Date(2020, 2, 1), false)).toBe(null);
    expect(p.current?.name).toBe('c.mp4');
    expect(p.goToDate(new Date(2020, 1, 15), false)).toBe('nothing-that-day');
    expect(p.current?.name).toBe('c.mp4');
    expect(p.goToDate(new Date(2019, 0, 1), false)).toBe('before-first');
    expect(p.goToDate(new Date(2021, 0, 1), false)).toBe('after-last');
    expect(p.current?.name).toBe('e.mp4');
    expect(p.goToDate(new Date(2020, 1, 15, 8), true)).toBe(null);
  });

  describe('cycleFilter', () => {
    it('passe à la vidéo suivante par date, puis à la photo suivante', () => {
      const p = loaded();
      p.goTo(1);                                             // b.jpg
      expect(p.cycleFilter()).toBe(true);
      expect(p.filter).toBe('video');
      expect(names(p.items)).toEqual(['c.mp4', 'e.mp4']);
      expect(p.current?.name).toBe('c.mp4');

      expect(p.cycleFilter()).toBe(true);
      expect(p.filter).toBe('image');
      expect(p.current?.name).toBe('d.jpg');
    });

    it('garde le média courant s’il reste visible', () => {
      const p = loaded();
      p.goTo(3);                                             // d.jpg
      p.cycleFilter();                                       // vidéos : e.mp4
      p.cycleFilter();                                       // photos : rien après e.mp4, retour au début
      expect(p.current?.name).toBe('a.jpg');
      p.cycleFilter();                                       // tout : a.jpg reste
      expect(p.filter).toBe('all');
      expect(p.current?.name).toBe('a.jpg');
      expect(p.position).toBe(0);
    });

    it('refuse quand le dossier n’a qu’un type de média', () => {
      const photos = loaded(folder().filter(m => m.type === 'image'));
      expect(photos.cycleFilter()).toBe(false);
      expect(photos.filter).toBe('all');
      expect(photos.length).toBe(3);
    });
  });
});

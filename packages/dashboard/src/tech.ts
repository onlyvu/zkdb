import { useEffect, useState } from 'react';

/**
 * Two depths for every screen. Plain by default: what changed, who signed, whether it checks out. With chain details
 * on, the same screens also show hashes, addresses, gas and proof numbers. The choice is kept on this device.
 * Elements marked `.tech-only` are hidden until it is on (see styles.css).
 */
const KEY = 'zkdb.tech';

const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

const apply = (on: boolean) => { document.documentElement.dataset.tech = on ? 'on' : 'off'; };

export function useTech(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => apply(on), [on]);
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      // Private window: the choice lasts for this page only.
    }
  };
  return [on, set];
}

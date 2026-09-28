import React from 'react';
import { Platform, StyleSheet, Text } from 'react-native';

export type IconName = 'music' | 'library' | 'queue' | 'sync' | 'search' |
  'play' | 'pause' | 'previous' | 'next' | 'repeatAll' | 'repeatOne' | 'volume' |
  'favorite' | 'favoriteFilled' | 'playlist' | 'add' | 'remove' | 'delete' | 'up' | 'down' |
  'shuffle' | 'recent' | 'drag' | 'download' | 'offline' | 'timer' | 'speed' |
  'home' | 'artist' | 'album' | 'expand';

// Windows system icon font; no image assets or emoji rendering are involved.
const windowsGlyphs: Record<IconName, string> = {
  music: '\uEC4F', library: '\uE8F1', queue: '\uE907', sync: '\uE895', search: '\uE721',
  play: '\uE768', pause: '\uE769', previous: '\uE892', next: '\uE893',
  repeatAll: '\uE8EE', repeatOne: '\uE8ED', volume: '\uE767',
  favorite: '\uE734', favoriteFilled: '\uE735', playlist: '\uE8FD',
  add: '\uE710', remove: '\uE738', delete: '\uE74D', up: '\uE70E', down: '\uE70D',
  shuffle: '\uE8B1', recent: '\uE823', drag: '\uE700',
  download: '\uE896', offline: '\uE753', timer: '\uE916', speed: '\uE7F7',
  home: '\uE80F', artist: '\uE77B', album: '\uE93C', expand: '\uE740',
};

const fallbackGlyphs: Record<IconName, string> = {
  music: '♪', library: '▤', queue: '☷', sync: '↻', search: '⌕',
  play: '▶︎', pause: 'Ⅱ', previous: '|◀', next: '▶|',
  repeatAll: '↻', repeatOne: '↻1', volume: '◁',
  favorite: '☆', favoriteFilled: '★', playlist: '☷', add: '+', remove: '−',
  delete: '×', up: '↑', down: '↓',
  shuffle: '⇄', recent: '◷', drag: '≡',
  download: '↓', offline: '✓', timer: '◷', speed: '×',
  home: '⌂', artist: '●', album: '▣', expand: '↗',
};

export function Icon({ name, size = 18, color = '#f5f7fc' }:
  { name: IconName; size?: number; color?: string }) {
  const windows = Platform.OS === 'windows';
  return <Text accessible={false} style={[s.icon, windows && s.windows,
    { fontSize: size, lineHeight: size * 1.25, color }]}>
    {windows ? windowsGlyphs[name] : fallbackGlyphs[name]}
  </Text>;
}

const s = StyleSheet.create({
  icon: { textAlign: 'center' },
  windows: { fontFamily: 'Segoe MDL2 Assets' },
});

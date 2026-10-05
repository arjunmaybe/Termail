/**
 * Color theme for the TUI
 */

export const theme = {
  dark: {
    background: '#1a1b26',
    surface: '#24283b',
    surfaceHover: '#2f334d',
    border: '#414868',
    primary: '#7aa2f7',
    primaryHover: '#89b4fa',
    secondary: '#bb9af7',
    accent: '#f7768e',
    success: '#9ece6a',
    warning: '#e0af68',
    error: '#f7768e',
    textPrimary: '#c0caf5',
    textSecondary: '#a9b1d6',
    textMuted: '#565f89',
    textInverse: '#1a1b26',
    focusRing: '#7aa2f7',
  },
  light: {
    background: '#f7f7f7',
    surface: '#ffffff',
    surfaceHover: '#f0f0f0',
    border: '#d0d0d0',
    primary: '#2b6cb0',
    primaryHover: '#2c5282',
    secondary: '#6b46c1',
    accent: '#c53030',
    success: '#276749',
    warning: '#b7791f',
    error: '#c53030',
    textPrimary: '#1a202c',
    textSecondary: '#4a5568',
    textMuted: '#a0aec0',
    textInverse: '#ffffff',
    focusRing: '#2b6cb0',
  },
} as const;

export type Theme = typeof theme.dark;

export function getTheme(mode: 'dark' | 'light' = 'dark'): Theme {
  return theme[mode] as Theme;
}

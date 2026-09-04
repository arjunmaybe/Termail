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

// Style helpers for @opentui/core
export const styles = {
  container: (theme: Theme) => ({
    backgroundColor: theme.background,
    color: theme.textPrimary,
    height: '100%',
    width: '100%',
  }),

  sidebar: (theme: Theme, collapsed: boolean) => ({
    backgroundColor: theme.surface,
    borderRight: `1px solid ${theme.border}`,
    width: collapsed ? '0' : '30%',
    minWidth: collapsed ? '0' : '20ch',
    overflow: 'hidden',
    height: '100%',
  }),

  contentPane: (theme: Theme) => ({
    backgroundColor: theme.background,
    flex: 1,
    overflow: 'auto',
    height: '100%',
  }),

  statusBar: (theme: Theme) => ({
    backgroundColor: theme.surface,
    borderTop: `1px solid ${theme.border}`,
    color: theme.textSecondary,
    padding: '0 1',
    height: 1,
  }),

  folderTab: (theme: Theme, active: boolean) => ({
    padding: '0 1',
    color: active ? theme.primary : theme.textSecondary,
    backgroundColor: active ? theme.surfaceHover : 'transparent',
    borderBottom: active ? `1px solid ${theme.primary}` : 'none',
    fontWeight: active ? 'bold' : 'normal',
  }),

  folderItem: (theme: Theme, selected: boolean, unread: number) => ({
    padding: '0 1',
    color: selected ? theme.textPrimary : theme.textSecondary,
    backgroundColor: selected ? theme.surfaceHover : 'transparent',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  }),

  unreadBadge: (theme: Theme) => ({
    color: theme.background,
    backgroundColor: theme.primary,
    borderRadius: 2,
    padding: '0 1',
    fontSize: 'small',
    minWidth: 2,
    textAlign: 'center',
  }),

  emailItem: (theme: Theme, selected: boolean, unread: boolean) => ({
    padding: '0 1',
    color: selected ? theme.textPrimary : unread ? theme.textPrimary : theme.textSecondary,
    backgroundColor: selected ? theme.surfaceHover : 'transparent',
    fontWeight: unread ? 'bold' : 'normal',
    borderBottom: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  }),

  emailHeader: (theme: Theme) => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  }),

  emailFrom: (theme: Theme) => ({
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),

  emailDate: (theme: Theme) => ({
    color: theme.textMuted,
    fontSize: 'small',
    marginLeft: 1,
  }),

  emailSubject: (theme: Theme) => ({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.textSecondary,
  }),

  emailPreview: (theme: Theme) => ({
    color: theme.textMuted,
    fontSize: 'small',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),

  welcomeView: (theme: Theme) => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: theme.textMuted,
    gap: 1,
  }),

  welcomeTitle: (theme: Theme) => ({
    color: theme.textPrimary,
    fontSize: 'large',
    fontWeight: 'bold',
  }),

  welcomeSubtitle: (theme: Theme) => ({
    color: theme.textMuted,
  }),

  statusBarLeft: (theme: Theme) => ({
    flex: 1,
    display: 'flex',
    gap: 2,
  }),

  statusBarRight: (theme: Theme) => ({
    display: 'flex',
    gap: 2,
    color: theme.textMuted,
  }),

  keyBinding: (theme: Theme) => ({
    color: theme.primary,
    fontWeight: 'bold',
  }),

  keyDescription: (theme: Theme) => ({
    color: theme.textSecondary,
  }),
};

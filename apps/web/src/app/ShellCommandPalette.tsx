import { useNavigate } from '@tanstack/react-router';
import { House, Moon, Palette, Sun } from 'lucide-react';
import { CommandPalette } from '../components/CommandPalette/CommandPalette';
import { useTheme } from '../lib/useTheme';

interface ShellCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** App-level palette actions. People and place search join here once the API exists. */
export default function ShellCommandPalette({ open, onOpenChange }: ShellCommandPaletteProps) {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={[
        {
          heading: 'Actions',
          items: [
            {
              id: 'home',
              label: 'Go to start page',
              icon: <House size={16} aria-hidden />,
              keywords: ['home'],
              onSelect: () => void navigate({ to: '/' }),
            },
            {
              id: 'design',
              label: 'Open design system',
              icon: <Palette size={16} aria-hidden />,
              keywords: ['components', 'kitchen sink'],
              onSelect: () => void navigate({ to: '/design' }),
            },
            {
              id: 'theme',
              label: `Switch to ${next} theme`,
              icon:
                next === 'dark' ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />,
              keywords: ['theme', 'dark', 'light', 'appearance'],
              onSelect: toggle,
            },
          ],
        },
      ]}
    />
  );
}

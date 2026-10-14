import { House, LayoutGrid, Map as MapIcon, Maximize, Search, ZoomIn, ZoomOut } from 'lucide-react';
import { Tooltip } from '../Tooltip/Tooltip';
import { IconButton } from '../IconButton/IconButton';
import iconButtonStyles from '../IconButton/IconButton.module.css';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../Menu/Menu';
import { Toolbar } from '../Toolbar/Toolbar';
import { cx } from '../../lib/cx';
import styles from './TreeToolbar.module.css';

export type TreeLayout = 'family' | 'pedigree' | 'descendants' | 'fan';

export const treeLayoutLabel: Record<TreeLayout, string> = {
  family: 'Family view',
  pedigree: 'Pedigree',
  descendants: 'Descendants',
  fan: 'Fan chart',
};

export interface TreeToolbarProps {
  layout: TreeLayout;
  onLayoutChange: (layout: TreeLayout) => void;
  onFind: () => void;
  onHome: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Control the layout menu, e.g. to open it from the `L` shortcut. */
  layoutMenuOpen?: boolean;
  onLayoutMenuOpenChange?: (open: boolean) => void;
  /** Shows a Minimap toggle (shortcut `M`) when given. */
  minimapVisible?: boolean;
  onToggleMinimap?: () => void;
  className?: string;
}

const icon = { size: 18, 'aria-hidden': true } as const;

/** Vertical floating toolbar on the tree canvas. Shortcuts are bound by the tree view. */
export function TreeToolbar({
  layout,
  onLayoutChange,
  onFind,
  onHome,
  onZoomIn,
  onZoomOut,
  onFit,
  layoutMenuOpen,
  onLayoutMenuOpenChange,
  minimapVisible,
  onToggleMinimap,
  className,
}: TreeToolbarProps) {
  const side = 'right';
  return (
    <Toolbar label="Tree tools" orientation="vertical" className={cx(styles.toolbar, className)}>
      <Menu open={layoutMenuOpen} onOpenChange={onLayoutMenuOpenChange}>
        <Tooltip content="Change layout" shortcut="L" side={side}>
          <MenuTrigger
            className={cx(iconButtonStyles.iconButton, iconButtonStyles.md)}
            aria-label={`Layout: ${treeLayoutLabel[layout]}`}
            aria-keyshortcuts="L"
          >
            <LayoutGrid {...icon} />
          </MenuTrigger>
        </Tooltip>
        <MenuContent side="right" align="start">
          <MenuRadioGroup value={layout} onValueChange={(v) => onLayoutChange(v as TreeLayout)}>
            {(Object.keys(treeLayoutLabel) as TreeLayout[]).map((key) => (
              <MenuRadioItem key={key} value={key}>
                {treeLayoutLabel[key]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <IconButton
        label="Find in tree"
        shortcut="F"
        tooltipSide={side}
        icon={<Search {...icon} />}
        onClick={onFind}
      />
      <IconButton
        label="Go to home person"
        shortcut="H"
        tooltipSide={side}
        icon={<House {...icon} />}
        onClick={onHome}
      />
      <span className={styles.divider} aria-hidden />
      <IconButton
        label="Zoom in"
        shortcut="+"
        tooltipSide={side}
        icon={<ZoomIn {...icon} />}
        onClick={onZoomIn}
      />
      <IconButton
        label="Zoom out"
        shortcut="-"
        tooltipSide={side}
        icon={<ZoomOut {...icon} />}
        onClick={onZoomOut}
      />
      <IconButton
        label="Fit to screen"
        shortcut="0"
        tooltipSide={side}
        icon={<Maximize {...icon} />}
        onClick={onFit}
      />
      {onToggleMinimap && (
        <IconButton
          label="Minimap"
          shortcut="M"
          tooltipSide={side}
          pressed={Boolean(minimapVisible)}
          icon={<MapIcon {...icon} />}
          onClick={onToggleMinimap}
        />
      )}
    </Toolbar>
  );
}

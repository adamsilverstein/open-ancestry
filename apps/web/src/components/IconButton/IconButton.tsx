import { Tooltip } from '../Tooltip/Tooltip';
import { IconButtonBase, type IconButtonBaseProps } from './IconButtonBase';

export interface IconButtonProps extends IconButtonBaseProps {
  /** Set false to skip the tooltip (e.g. when the label is visible nearby). */
  tooltip?: boolean;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

/** Icon-only button; the label is its accessible name and its tooltip, with the shortcut. */
export function IconButton({ tooltip = true, tooltipSide, ...props }: IconButtonProps) {
  const button = <IconButtonBase {...props} />;
  if (!tooltip) return button;
  return (
    <Tooltip content={props.label} shortcut={props.shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  );
}

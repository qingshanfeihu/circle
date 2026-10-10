import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileText, Search, X } from 'lucide-react';
import { Button, IconButton } from './ui';
export { Button, IconButton, Modal, Badge, DataBlock, EmptyState } from './ui';
export function Page({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page-heading">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
export function SearchInput({
  value,
  onChange,
  label = 'search',
  placeholder = 'search…',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
}) {
  return (
    <div className="search-field">
      <Search size={15} />
      <input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <IconButton label="clear search" onClick={() => onChange('')}>
          <X size={13} />
        </IconButton>
      )}
    </div>
  );
}
export function Facts({ values }: { values: Record<string, ReactNode> }) {
  return (
    <dl className="facts">
      {Object.entries(values).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input
        aria-label={label}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i />
    </label>
  );
}
export function Fold({
  title,
  open,
  onToggle,
  children,
}: {
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fold">
      <button className="fold-title" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value.replaceAll(' ', '-')}`}>
      <i />
      {value}
    </span>
  );
}
export function FileChip({
  name,
  onClick,
  onRemove,
}: {
  name: string;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  return (
    <span className="file-chip">
      <button onClick={onClick}>
        <FileText size={12} />
        {name}
      </button>
      {onRemove && (
        <button aria-label={`remove ${name}`} onClick={onRemove}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}
export function PreviewNotice() {
  return (
    <div className="preview-note">local preview · runtime not connected</div>
  );
}
export function RequestNotice() {
  return (
    <p className="muted small">
      Requests stay in this browser until a runtime is connected.
    </p>
  );
}

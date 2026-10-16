import { useId, useState, type ReactNode } from 'react';
import {
  Bold,
  BookMarked,
  Italic,
  Map as MapIcon,
  Pencil,
  Plus,
  Search,
  Trash2,
  Underline,
  ZoomIn,
} from 'lucide-react';
import {
  Avatar,
  Button,
  Checkbox,
  Combobox,
  CommandPalette,
  ConfirmDialog,
  DateInput,
  Dialog,
  DialogClose,
  EmptyState,
  GenerationLabel,
  IconButton,
  Input,
  LifespanText,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Minimap,
  Panel,
  PersonCard,
  PersonName,
  Popover,
  PopoverContent,
  PopoverTrigger,
  QuickViewPopover,
  RelationshipChart,
  RelationshipList,
  Select,
  Skeleton,
  SourceItem,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TagBadge,
  Textarea,
  TimelineItem,
  Toolbar,
  Tooltip,
  TreeToolbar,
  treeLayoutLabel,
  useToast,
  type LifeEvent,
  type MinimapNode,
  type TreeLayout,
} from '../components';
import type { Rect } from '../lib/minimap';
import type { PersonSummary, TagColor } from '../lib/person';
import styles from './DesignPage.module.css';

// Synthetic people only; never real family data.
const thaddeus: PersonSummary = {
  id: 'I2',
  name: 'Thaddeus Marlowe',
  sex: 'M',
  birth: { year: 1911 },
  death: { year: 1957 },
  sourceCount: 3,
  tags: [{ label: 'Immigrant', color: 2 }],
};
const eleanor: PersonSummary = {
  id: 'I1',
  name: 'Eleanor Whitcombe',
  sex: 'F',
  birth: { year: 1911 },
  death: { year: 1984 },
  photoUrl: '/design/portrait.svg',
  sourceCount: 1,
};
const wilhelmina: PersonSummary = {
  id: 'I3',
  name: 'Wilhelmina Ostrander',
  sex: 'F',
  birth: { year: 1890, qualifier: 'abt' },
  death: { year: 1955 },
};
const rafferty: PersonSummary = {
  id: 'I4',
  name: 'Rafferty Quill',
  sex: 'M',
  birth: { year: 1947 },
  living: true,
};
const unknown: PersonSummary = {
  id: 'I5',
  name: 'Ashby Fennimore-Castellanos Delacroix',
  sex: 'U',
  birth: { year: 1820 },
};

const lifeEvents: Record<string, { birth?: LifeEvent; death?: LifeEvent }> = {
  I1: {
    birth: { date: '5 Sep 1911', place: 'Philadelphia, PA' },
    death: { date: '12 Mar 1984', place: 'Boston, MA' },
  },
  I2: {
    birth: { date: '2 Feb 1911', place: 'Cork, Ireland' },
    death: { date: '1957', place: 'Philadelphia, PA' },
  },
};

const places = [
  'Philadelphia, PA',
  'Boston, MA',
  'Cork, Ireland',
  'Hamburg, Germany',
  'Kraków, Poland',
  'Ellis Island, NY',
].map((label) => ({ value: label, label }));

const tagNames = [
  'Immigrant',
  'Military',
  'Brick wall',
  'DNA match',
  'Needs sources',
  'Land records',
  'Farmers',
  'Research later',
];

const minimapBounds: Rect = { x: 0, y: 0, width: 1600, height: 900 };
const minimapNodes: MinimapNode[] = Array.from({ length: 40 }, (_, i) => ({
  x: 40 + (i % 10) * 150,
  y: 60 + Math.floor(i / 10) * 210,
  width: 120,
  height: 150,
  sex: (['M', 'F', 'U'] as const)[i % 3],
}));

const swatches = [
  'bg',
  'surface',
  'surface-sunken',
  'canvas',
  'canvas-line',
  'text',
  'text-muted',
  'border',
  'border-strong',
  'accent',
  'focus',
  'person-male',
  'person-female',
  'person-unknown',
  'warning',
  'danger',
  'info',
];

function Section({
  title,
  notes,
  children,
}: {
  title: string;
  notes?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {notes && <p className={styles.notes}>{notes}</p>}
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className={styles.rowWrap}>
      {label && <p className={styles.rowLabel}>{label}</p>}
      <div className={styles.row}>{children}</div>
    </div>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <p role="status" className={styles.status}>
      {children}
    </p>
  );
}

/** Kitchen sink: every component in every state. Snapshot tested in both themes. */
export function DesignPage() {
  const toast = useToast();
  const [pressed, setPressed] = useState(false);
  const [eventType, setEventType] = useState<string | undefined>(undefined);
  const [place, setPlace] = useState<string | undefined>(undefined);
  const [quickView, setQuickView] = useState('');
  const [quickViewPerson, setQuickViewPerson] = useState<PersonSummary | null>(null);
  const [quickViewAnchor, setQuickViewAnchor] = useState<HTMLElement | null>(null);
  const [quickViewOpen, setQuickViewOpen] = useState(false);
  const [relationship, setRelationship] = useState('');
  const [treeAction, setTreeAction] = useState('');
  const [layout, setLayout] = useState<TreeLayout>('family');
  const [viewport, setViewport] = useState<Rect>({ x: 300, y: 200, width: 600, height: 340 });
  const [minimapVisible, setMinimapVisible] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dates, setDates] = useState(['abt 1890', '05/06/1960', 'when the mill burned', '']);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState('');

  const center = (point: { x: number; y: number }) =>
    setViewport((v) => ({ ...v, x: point.x - v.width / 2, y: point.y - v.height / 2 }));

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Design system</h1>
        <p className={styles.notes}>
          Tokens and components for open-ancestry. Toggle the theme in the top bar to see both
          themes. Source of truth: docs/design-system.md.
        </p>
      </header>

      <Section title="Tokens" notes="Semantic color tokens; components never use raw colors.">
        <div className={styles.swatches}>
          {swatches.map((name) => (
            <div key={name} className={styles.swatch}>
              <span className={styles.chip} style={{ background: `var(--oa-${name})` }} />
              <code>--oa-{name}</code>
            </div>
          ))}
        </div>
        <div className={styles.typeScale}>
          <p className={styles.display}>Display 36 serif</p>
          <p style={{ font: 'var(--oa-text-xl)' }}>Text xl 24</p>
          <p style={{ font: 'var(--oa-text-lg)' }}>Text lg 18</p>
          <p style={{ font: 'var(--oa-text-md)' }}>Text md 15</p>
          <p style={{ font: 'var(--oa-text-sm)' }}>Text sm 13</p>
          <p style={{ font: 'var(--oa-text-xs)' }}>Text xs 12</p>
          <p style={{ fontFamily: 'var(--oa-font-mono)' }}>0 @I123@ INDI</p>
        </div>
      </Section>

      <Section title="Button" notes="Variants primary, secondary, ghost, danger; sizes md and sm.">
        {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
          <Row key={variant} label={variant}>
            <Button variant={variant}>{variant === 'danger' ? 'Delete' : 'Primary'}</Button>
            <Button variant={variant} data-demo-hover="">
              Hover
            </Button>
            <Button variant={variant} data-demo-focus="">
              Focus
            </Button>
            <Button variant={variant} disabled>
              Disabled
            </Button>
            <Button variant={variant} size="sm" iconStart={<Plus size={14} aria-hidden />}>
              Small
            </Button>
          </Row>
        ))}
        <Row label="loading">
          <Button variant="primary" loading>
            Saving
          </Button>
        </Row>
      </Section>

      <Section title="IconButton" notes="Always labelled; tooltip shows label and shortcut.">
        <Row>
          <IconButton label="Zoom in" shortcut="+" icon={<ZoomIn size={18} aria-hidden />} />
          <IconButton label="Search" variant="secondary" icon={<Search size={18} aria-hidden />} />
          <IconButton label="Edit" data-demo-hover="" icon={<Pencil size={18} aria-hidden />} />
          <IconButton label="Delete" data-demo-focus="" icon={<Trash2 size={18} aria-hidden />} />
          <IconButton
            label="Show minimap"
            pressed={pressed}
            onClick={() => setPressed((p) => !p)}
            icon={<MapIcon size={18} aria-hidden />}
          />
          <IconButton label="Disabled" disabled icon={<Plus size={18} aria-hidden />} />
          <IconButton label="Small" size="sm" icon={<Plus size={14} aria-hidden />} />
        </Row>
      </Section>

      <Section title="Toolbar" notes="One Tab stop; arrow keys, Home and End move focus.">
        <Toolbar label="Demo toolbar">
          <IconButton label="Bold" icon={<Bold size={18} aria-hidden />} />
          <IconButton label="Italic" icon={<Italic size={18} aria-hidden />} />
          <IconButton label="Underline" icon={<Underline size={18} aria-hidden />} />
        </Toolbar>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="facts">
          <TabsList aria-label="Person sections">
            <TabsTrigger value="facts">Facts</TabsTrigger>
            <TabsTrigger value="gallery">Gallery</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="sources" disabled>
              Sources
            </TabsTrigger>
          </TabsList>
          <TabsContent value="facts">Timeline, sources and relationships.</TabsContent>
          <TabsContent value="gallery">No photos yet.</TabsContent>
          <TabsContent value="notes">No notes yet.</TabsContent>
        </Tabs>
      </Section>

      <Section title="Popover">
        <Popover>
          <PopoverTrigger asChild>
            <Button>Open popover</Button>
          </PopoverTrigger>
          <PopoverContent label="Filter events">
            <div className={styles.stack}>
              <Checkbox label="Family events" defaultChecked />
              <Checkbox label="Alternate facts" />
            </div>
          </PopoverContent>
        </Popover>
      </Section>

      <Section title="Dialog" notes="Focus is trapped and restored to the trigger on close.">
        <Dialog
          title="Edit person"
          description="Changes are saved to this tree only."
          trigger={<Button>Open dialog</Button>}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button variant="primary">Save</Button>
              </DialogClose>
            </>
          }
        >
          <div className={styles.stack}>
            <Input label="Given names" defaultValue="Eleanor" />
            <Input
              label="Surname"
              defaultValue="Whitcombe"
              suggestions={['Whitcombe', 'Whitfield', 'Whitlock']}
            />
          </div>
        </Dialog>
      </Section>

      <Section title="Tooltip">
        <Tooltip content="Tooltips describe controls" shortcut="?">
          <Button variant="ghost">Hover for tooltip</Button>
        </Tooltip>
      </Section>

      <Section title="Toast">
        <Row>
          <Button
            onClick={() =>
              toast({ title: 'Changes saved', description: 'Eleanor Whitcombe updated.' })
            }
          >
            Show toast
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              toast({ title: 'Could not save', description: 'Try again.', variant: 'error' })
            }
          >
            Show error toast
          </Button>
        </Row>
      </Section>

      <Section title="Input">
        <div className={styles.formGrid}>
          <Input
            label="Given names"
            placeholder="e.g. Eleanor May"
            hint="All given names, in order"
          />
          <Input label="Surname" error="Surname is required" />
          <Input label="Hovered" data-demo-hover="" defaultValue="Hover state" />
          <Input label="Focused" data-demo-focus="" defaultValue="Focus state" />
          <Input label="Record id" disabled defaultValue="@I123@" />
        </div>
      </Section>

      <Section
        title="DateInput"
        notes="Text is kept as typed; the preview shows how it is read, ambiguity, or that it is not a date."
      >
        <div className={styles.formGrid}>
          {['Approximate', 'Ambiguous', 'Not a date', 'Empty'].map((label, i) => (
            <DateInput
              key={label}
              label={label}
              value={dates[i]!}
              hint=""
              onValueChange={(value) => setDates((d) => d.map((v, j) => (j === i ? value : v)))}
            />
          ))}
        </div>
      </Section>

      <Section
        title="ConfirmDialog"
        notes="Alert dialog for destructive actions; Cancel is focused first."
      >
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          Delete record
        </Button>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Delete this record?"
          description="You can undo this."
          confirmLabel="Delete record"
          onConfirm={() => setConfirmed('Deleted')}
        />
        <Status>{confirmed}</Status>
      </Section>

      <Section title="Textarea">
        <div className={styles.formGrid}>
          <Textarea label="Notes" placeholder="Research notes" />
          <Textarea label="Disabled notes" disabled defaultValue="Read only" />
        </div>
      </Section>

      <Section title="Select">
        <div className={styles.formGrid}>
          <Select
            label="Event type"
            placeholder="Choose an event"
            value={eventType}
            onValueChange={setEventType}
            options={[
              { value: 'birth', label: 'Birth' },
              { value: 'baptism', label: 'Baptism' },
              { value: 'marriage', label: 'Marriage' },
              { value: 'death', label: 'Death' },
              { value: 'burial', label: 'Burial', disabled: true },
            ]}
          />
          <Select label="Disabled select" disabled options={[]} placeholder="Unavailable" />
        </div>
      </Section>

      <Section title="Combobox">
        <div className={styles.formGrid}>
          <Combobox
            label="Place"
            placeholder="Choose a place"
            emptyText="No matching places"
            options={places}
            value={place}
            onValueChange={setPlace}
          />
          <Combobox label="Disabled place" options={places} disabled />
        </div>
      </Section>

      <Section title="Checkbox">
        <div className={styles.stack}>
          <Checkbox
            label="Show living people"
            description="Living people are private by default."
          />
          <Checkbox label="Some sources selected" indeterminate />
          <Checkbox label="Checked" defaultChecked />
          <Checkbox label="Disabled" disabled />
        </div>
      </Section>

      <Section title="Switch">
        <div className={styles.stack}>
          <Switch label="Show minimap" />
          <Switch label="Show generation labels" defaultChecked />
          <Switch label="Disabled switch" disabled />
        </div>
      </Section>

      <Section title="Skeleton" notes="Sized to final content; container sets aria-busy.">
        <Row>
          <Skeleton shape="circle" width={64} height={64} />
          <div className={styles.stack}>
            <Skeleton shape="text" width={200} />
            <Skeleton shape="text" width={140} />
          </div>
          <Skeleton width={120} height={150} />
        </Row>
      </Section>

      <Section title="EmptyState">
        <EmptyState
          icon={<BookMarked size={24} aria-hidden />}
          title="No sources yet"
          level={3}
          description="Add a source to back up this fact."
          action={<Button size="sm">Add source</Button>}
        />
      </Section>

      <Section title="Panel">
        <div className={styles.formGrid}>
          <Panel
            title="Sources"
            headingLevel={3}
            actions={
              <IconButton label="Add source" size="sm" icon={<Plus size={14} aria-hidden />} />
            }
          >
            <p>Raised panel for page columns.</p>
          </Panel>
          <Panel variant="sunken">
            <p>Sunken panel without a title.</p>
          </Panel>
        </div>
      </Section>

      <Section
        title="Avatar"
        notes="Photo (lazy, async decode), or silhouette with sex icon, or initials."
      >
        <Row label="photo">
          {([24, 40, 64, 120] as const).map((size) => (
            <Avatar key={size} name={eleanor.name} sex="F" src={eleanor.photoUrl} size={size} />
          ))}
        </Row>
        <Row label="silhouette">
          {(['M', 'F', 'U'] as const).map((sex) => (
            <Avatar key={sex} name={`Silhouette ${sex}`} sex={sex} size={64} />
          ))}
          <Avatar
            name={rafferty.name}
            sex="M"
            size={40}
            src="/design/missing.jpg"
            data-testid="avatar-broken"
          />
        </Row>
        <Row label="initials">
          {(['M', 'F', 'U'] as const).map((sex) => (
            <Avatar key={sex} name={`Initials ${sex}`} sex={sex} size={40} fallback="initials" />
          ))}
        </Row>
      </Section>

      <Section title="LifespanText">
        <ul className={styles.plainList}>
          <li>
            <LifespanText birth={{ year: 1911 }} death={{ year: 1957 }} />
          </li>
          <li>
            <LifespanText birth={{ year: 1947 }} living />
          </li>
          <li>
            <LifespanText birth={{ year: 1890, qualifier: 'abt' }} death={{ year: 1955 }} />
          </li>
          <li>
            <LifespanText birth={{ year: 1820 }} />
          </li>
          <li>
            <LifespanText death={{ year: 1880 }} />
          </li>
        </ul>
      </Section>

      <Section
        title="PersonName"
        notes="Isolated with <bdi>, so a right-to-left name keeps the text after it in order; control and override characters are removed."
      >
        <ul className={styles.plainList}>
          <li>
            <PersonName name="Thaddeus Marlowe" />{' '}
            <LifespanText birth={{ year: 1911 }} death={{ year: 1957 }} />
          </li>
          <li>
            <PersonName name="שרה כהן" />{' '}
            <LifespanText birth={{ year: 1911 }} death={{ year: 1957 }} />
          </li>
          <li>
            <PersonName name={'Evil\u202e Ashdown'} /> <LifespanText birth={{ year: 1880 }} />
          </li>
        </ul>
      </Section>

      <Section
        title="PersonCard"
        notes="Sex shown by stripe color and icon; states by border, icon and label."
      >
        <div className={styles.canvasDemo} data-surface="canvas">
          <Row>
            <PersonCard person={thaddeus} />
            <PersonCard person={eleanor} data-demo-hover="" />
            <PersonCard person={wilhelmina} data-demo-focus="" />
            <PersonCard person={unknown} />
            <PersonCard person={thaddeus} selected />
            <PersonCard person={eleanor} focusPerson />
            <PersonCard person={wilhelmina} duplicate />
            <PersonCard person={rafferty} />
            <PersonCard person={rafferty} isPrivate />
          </Row>
          <Row>
            <PersonCard person={thaddeus} size="compact" />
            <PersonCard person={eleanor} size="compact" focusPerson />
            <PersonCard person={wilhelmina} size="compact" duplicate />
            <PersonCard person={rafferty} size="compact" isPrivate />
          </Row>
        </div>
      </Section>

      <Section title="QuickViewPopover">
        <div className={styles.canvasDemo} data-surface="canvas">
          <Row>
            {[eleanor, thaddeus].map((person) => (
              <PersonCard
                key={person.id}
                person={person}
                aria-haspopup="dialog"
                aria-expanded={quickViewOpen && quickViewPerson?.id === person.id}
                onClick={(event) => {
                  setQuickViewPerson(person);
                  setQuickViewAnchor(event.currentTarget);
                  setQuickViewOpen(true);
                }}
              />
            ))}
          </Row>
          {/* One popover for the whole canvas, anchored to the clicked card. */}
          <QuickViewPopover
            person={quickViewPerson}
            anchor={quickViewAnchor}
            open={quickViewOpen}
            onOpenChange={setQuickViewOpen}
            birth={quickViewPerson ? lifeEvents[quickViewPerson.id]?.birth : undefined}
            death={quickViewPerson ? lifeEvents[quickViewPerson.id]?.death : undefined}
            onMakeFocus={(p) => setQuickView(`Make focus: ${p.name}`)}
            onEdit={(p) => setQuickView(`Edit: ${p.name}`)}
          />
        </div>
        <Status>{quickView}</Status>
      </Section>

      <Section title="TagBadge">
        <Row>
          {tagNames.map((label, i) => (
            <TagBadge key={label} label={label} color={(i + 1) as TagColor} />
          ))}
        </Row>
        <Row label="dots">
          {tagNames.map((label, i) => (
            <TagBadge key={label} label={label} color={(i + 1) as TagColor} variant="dot" />
          ))}
        </Row>
      </Section>

      <Section title="TimelineItem">
        <ol className={styles.plainList}>
          <TimelineItem
            year={1911}
            age={0}
            title="Birth"
            date="5 Sep 1911"
            place="Philadelphia, Pennsylvania, USA"
            sourceCount={2}
            actions={
              <IconButton label="Edit birth" size="sm" icon={<Pencil size={14} aria-hidden />} />
            }
          />
          <TimelineItem
            year="abt. 1911"
            title="Birth"
            date="abt. 1911"
            place="Camden, New Jersey, USA"
            variant="alternate"
          />
          <TimelineItem
            year={1914}
            age={3}
            title="Birth of brother Thaddeus Marlowe"
            place="Philadelphia, Pennsylvania, USA"
            variant="family"
          />
          <TimelineItem
            year={1936}
            age={24}
            title="Marriage"
            date="20 Jun 1936"
            place="Boston, MA"
          />
        </ol>
      </Section>

      <Section title="RelationshipList">
        <RelationshipList
          groups={[
            {
              title: 'Parents',
              people: [thaddeus, wilhelmina],
              onAdd: () => setRelationship('Add parent'),
              addLabel: 'Add parent',
            },
            { title: 'Spouse and children', people: [rafferty, unknown] },
          ]}
        />
        <Status>{relationship}</Status>
      </Section>

      <Section title="RelationshipChart">
        {/* Rafferty is Eleanor's 1st cousin 1x removed through Thaddeus and Wilhelmina's line. */}
        <RelationshipChart
          paths={[
            {
              label: '1st cousin 1x removed through Wilhelmina Ostrander',
              cells: [
                { person: rafferty, row: 3, col: 0, role: 'person' },
                { person: eleanor, row: 2, col: 0, role: 'between', step: 'parent' },
                { person: null, row: 1, col: 0, role: 'between', step: 'parent' },
                { person: wilhelmina, row: 0, col: 0, role: 'common-ancestor', step: 'parent' },
                { person: thaddeus, row: 1, col: 1, role: 'between', step: 'child' },
                { person: unknown, row: 2, col: 1, role: 'home', step: 'child' },
              ],
            },
            {
              label: 'nephew through Thaddeus Marlowe',
              cells: [
                { person: rafferty, row: 2, col: 0, role: 'person' },
                { person: eleanor, row: 1, col: 0, role: 'between', step: 'parent' },
                { person: thaddeus, row: 0, col: 0, role: 'common-ancestor', step: 'parent' },
                { person: unknown, row: 1, col: 1, role: 'home', step: 'child' },
              ],
            },
          ]}
        />
      </Section>

      <Section title="SourceItem">
        <SourceItem
          title="1920 United States Federal Census"
          citation="Philadelphia Ward 22, sheet 4B, line 61"
          quality={3}
          externalUrl="https://www.example.org/records/1920-census-demo"
        />
        <SourceItem
          title="Family Bible of the Marlowe household"
          citation="Births page"
          quality={1}
        />
      </Section>

      <Section title="GenerationLabel">
        <div className={styles.canvasDemo} data-surface="canvas">
          <GenerationLabel>Grandparents</GenerationLabel>
          <GenerationLabel>Parents</GenerationLabel>
        </div>
      </Section>

      <Section title="TreeToolbar">
        <div className={styles.canvasDemo} data-surface="canvas">
          <TreeToolbar
            layout={layout}
            onLayoutChange={(next) => {
              setLayout(next);
              setTreeAction(`Layout: ${next}`);
            }}
            onFind={() => setTreeAction('Find in tree')}
            onHome={() => setTreeAction('Go to home person')}
            onZoomIn={() => setTreeAction('Zoom in')}
            onZoomOut={() => setTreeAction('Zoom out')}
            onFit={() => setTreeAction('Fit to screen')}
          />
        </div>
        <Status>{treeAction || treeLayoutLabel[layout]}</Status>
      </Section>

      <Section title="Minimap">
        <div className={styles.canvasDemo} data-surface="canvas">
          {minimapVisible ? (
            <Minimap
              nodes={minimapNodes}
              bounds={minimapBounds}
              viewport={viewport}
              onNavigate={center}
              onDismiss={() => setMinimapVisible(false)}
            />
          ) : (
            <Button size="sm" onClick={() => setMinimapVisible(true)}>
              Show minimap
            </Button>
          )}
        </div>
        <Status>
          Viewport centered at {Math.round(viewport.x + viewport.width / 2)},{' '}
          {Math.round(viewport.y + viewport.height / 2)}
        </Status>
      </Section>

      <Section title="Menu">
        <Menu>
          <MenuTrigger asChild>
            <Button>Open menu</Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem>Rename</MenuItem>
            <MenuItem disabled>Merge (disabled)</MenuItem>
            <MenuItem
              aria-disabled
              aria-describedby="design-menu-why"
              onSelect={(e) => e.preventDefault()}
            >
              Export (unavailable, still reachable)
            </MenuItem>
            <MenuSeparator />
            <MenuItem>Delete</MenuItem>
            <MenuLabel id="design-menu-why">Export needs a tree. Import one first.</MenuLabel>
          </MenuContent>
        </Menu>
      </Section>

      <Section
        title="CommandPalette"
        notes="Cmd/Ctrl-K anywhere. People search is wired with the search API."
      >
        <Button onClick={() => setPaletteOpen(true)}>Open command palette</Button>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          groups={[
            {
              heading: 'People',
              items: [thaddeus, eleanor].map((p) => ({
                id: p.id,
                label: p.name,
                onSelect: () => undefined,
              })),
            },
          ]}
        />
      </Section>
    </div>
  );
}

import type { InsertRow } from '@open-ancestry/db';

type PlaceRow = InsertRow<'place'> & { id: string };

/** Splits a PLAC value into jurisdictions, smallest first, dropping empty ones (`, , Ohio`). */
export function placeParts(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * GEDCOM latitude or longitude (`N51.5`, `W0.25`, `-71.2`) to signed decimal
 * degrees, or undefined when unparseable or out of range.
 */
export function coordinate(value: string | undefined, axis: 'lat' | 'long'): number | undefined {
  // Capped and trimmed first, then at most one space after the hemisphere:
  // no backtracking over long runs of whitespace in hostile input.
  const trimmed = (value ?? '').trim();
  if (trimmed.length > 64) return undefined;
  const match = /^([NSEW])? ?([+-]?\d+(?:\.\d+)?)$/i.exec(trimmed);
  if (!match) return undefined;
  const hemisphere = match[1]?.toUpperCase();
  if (hemisphere && (axis === 'lat') !== (hemisphere === 'N' || hemisphere === 'S'))
    return undefined;
  let degrees = Number(match[2]);
  if (hemisphere === 'S' || hemisphere === 'W') degrees = -Math.abs(degrees);
  const limit = axis === 'lat' ? 90 : 180;
  return Number.isFinite(degrees) && Math.abs(degrees) <= limit ? degrees : undefined;
}

/**
 * Builds the place hierarchy from PLAC strings: `Elderford, Cask County, Ohio`
 * becomes Ohio <- Cask County, Ohio <- Elderford, Cask County, Ohio. Each
 * level is created once, keyed by its full name.
 */
export class Places {
  private readonly byName = new Map<string, PlaceRow>();
  private readonly byId = new Map<string, PlaceRow>();
  /** PLAC text as written -> place id; most files repeat a few hundred places many times. */
  private readonly byText = new Map<string, string | undefined>();

  private readonly newId: () => string;

  constructor(newId: () => string) {
    this.newId = newId;
  }

  /** Id of the place for a PLAC value, creating it and its parents; undefined for an empty value. */
  resolve(text: string): string | undefined {
    if (this.byText.has(text)) return this.byText.get(text);
    const id = this.create(text);
    this.byText.set(text, id);
    return id;
  }

  private create(text: string): string | undefined {
    const parts = placeParts(text);
    if (!parts.length) return undefined;
    let parentId: string | null = null;
    let place: PlaceRow | undefined;
    for (let i = parts.length - 1; i >= 0; i--) {
      const fullName = i === parts.length - 1 ? parts[i]! : `${parts[i]}, ${place!.full_name}`;
      place = this.byName.get(fullName);
      if (!place) {
        place = { id: this.newId(), name: parts[i]!, full_name: fullName, parent_id: parentId };
        this.byName.set(fullName, place);
        this.byId.set(place.id, place);
      }
      parentId = place.id;
    }
    return place!.id;
  }

  /** Sets coordinates on a place once; returns false when it already has different ones. */
  setCoordinates(id: string, latitude: number, longitude: number): boolean {
    const place = this.byId.get(id);
    if (!place) return false;
    if (place.latitude == null) {
      place.latitude = latitude;
      place.longitude = longitude;
      return true;
    }
    return place.latitude === latitude && place.longitude === longitude;
  }

  rows(): Iterable<PlaceRow> {
    return this.byName.values();
  }
}

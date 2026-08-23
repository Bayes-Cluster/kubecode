import type { ComponentType, SVGAttributes } from 'react'
import {
  Calendar,
  FileText,
  FlaskConical,
  Layers,
  RefreshCw,
  Tag,
  Target,
  Users,
  Wrench,
} from 'lucide-react'
import { resolveIcon } from '../../utils/iconRegistry'

const TYPE_ICON_MAP: Record<string, ComponentType<SVGAttributes<SVGSVGElement>>> = {
  Project: Wrench,
  project: Wrench,
  Experiment: FlaskConical,
  experiment: FlaskConical,
  Responsibility: Target,
  responsibility: Target,
  Procedure: RefreshCw,
  procedure: RefreshCw,
  Person: Users,
  person: Users,
  Event: Calendar,
  event: Calendar,
  Topic: Tag,
  topic: Tag,
  Type: Layers,
  type: Layers,
}

export function getTypeIcon(isA: string | null, customIcon?: string | null): ComponentType<SVGAttributes<SVGSVGElement>> {
  if (customIcon) return resolveIcon(customIcon)
  return (isA && (Reflect.get(TYPE_ICON_MAP, isA) as ComponentType<SVGAttributes<SVGSVGElement>> | undefined)) || FileText
}

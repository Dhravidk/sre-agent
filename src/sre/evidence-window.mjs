import {comparisonLaneSql} from './comparison-window.mjs';
import {logCandidateLaneSql} from './log-window.mjs';
import {inventorySelectionSql} from './source-inventory.mjs';

// Balance fact diversity within a directory, directories within a project,
// then projects/sources. A repeated hot directory must not evict a quiet
// project's retained navigation evidence before the candidate limit. Only
// selection keys and identities cross the ranking windows; hydrate afterward.
export function evidenceWindowSql(dialect){
 const comparison=comparisonLaneSql(dialect),logs=logCandidateLaneSql(dialect),inventory=inventorySelectionSql(dialect),isInventory="source='gitlab' AND kind='source_inventory'";
 return "WITH selectors AS (SELECT e.id,e.observed_at,e.source,e.kind,"+comparison+" AS comparison_family,"+logs+" AS log_family,"+inventory.project+" AS inventory_project,"+inventory.resource+" AS inventory_resource,"+inventory.facts+" AS inventory_facts,"+inventory.priority+" AS inventory_priority FROM sre_evidence e WHERE incident_id=? AND kind NOT IN ('responder_update','question')), repeats AS (SELECT id,observed_at,source,kind,comparison_family,log_family,inventory_project,inventory_resource,inventory_priority,CASE WHEN "+isInventory+" THEN ROW_NUMBER() OVER (PARTITION BY source,kind,inventory_project,inventory_resource,inventory_facts ORDER BY observed_at DESC,id DESC) ELSE 0 END AS inventory_repeat FROM selectors), families AS (SELECT id,observed_at,source,kind,inventory_project,ROW_NUMBER() OVER (PARTITION BY source,kind,comparison_family,log_family,inventory_project,inventory_resource ORDER BY inventory_repeat,inventory_priority,observed_at DESC,id DESC) AS family_rank FROM repeats), project_balanced AS (SELECT id,observed_at,source,kind,CASE WHEN "+isInventory+" THEN ROW_NUMBER() OVER (PARTITION BY source,kind,inventory_project ORDER BY family_rank,observed_at DESC,id DESC) ELSE family_rank END AS candidate_rank FROM families), ranked AS (SELECT id,observed_at,ROW_NUMBER() OVER (PARTITION BY source,kind ORDER BY candidate_rank,observed_at DESC,id DESC) AS source_rank FROM project_balanced), selected AS MATERIALIZED (SELECT id,observed_at,source_rank FROM ranked ORDER BY source_rank,observed_at DESC,id DESC LIMIT ?) SELECT e.*,s.source_rank FROM selected s JOIN sre_evidence e ON e.id=s.id ORDER BY s.source_rank,s.observed_at DESC,s.id DESC";
}

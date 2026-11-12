// 家系図ノート 閲覧ページ(docs/19_web_viewer_brief.md)
//
// 書き出した JSON(バックアップ)を、ブラウザの中だけで開いて描く。見るだけ。
//
// 【守り】docs/19 §3。このファイルは:
// - 通信をしない(通信の API を1つも呼ばない。CSP の connect-src 'none' でも止まる)
// - 端末に何も残さない(保存の API を1つも呼ばない。データはメモリの中だけ)
// - 受け取った文字を HTML として扱わない(要素は createElementNS、文字は textContent だけ)
// - リンクを作らない
// `test/security.test.js` が禁止語を検索して、これを確かめている。
//
// 【並べ方】アプリの `TreeApp/Layout/` と `TreeApp/Models/LayoutBridge.swift` を1行ずつ移した。
// 座標はアプリと一致する(`test/golden.test.js` が golden と 1e-9 まで突き合わせる)。
// **アプリの並べ方を変えたら golden を作り直し、ここを追いつかせる**(RELEASE_CHECKLIST)。
// 移植では次を守っている:
// - 合計は Swift と同じ順に足す(浮動小数の結果が変わらないように)
// - 並べ替えは安定(Swift の sort と同じ)。比較の規則は Swift のまま
// - Swift の `.rounded()` は「0から遠い側へ丸める」。Math.round とは負の数で違う
// - Int.max / greatestFiniteMagnitude は Infinity / Number.MAX_VALUE で置き換えた(比較にしか使わない)

(function () {
  'use strict';

  // MARK: - 定数

  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const CURRENT_FORMAT_VERSION = 2;

  const MESSAGES = {
    corrupted: 'ファイルを読み取れませんでした。家系図ノートで書き出したJSONファイルを選んでください。',
    tooLarge: 'ファイルが大きすぎます(20MB まで)。家系図ノートで書き出したJSONファイルを選んでください。',
    newer: (version) =>
      '新しい版のアプリで書き出されたファイルです(形式バージョン' + version + ')。このページではまだ表示できません。',
  };

  // MARK: - 読み込み(TreeJSONExport.swift / Snapshots.swift / PartialDate.swift の Decodable を写した)
  //
  // アプリの読み込みと同じく、**必須のキーが無い・型が違う・知らない種別** は「読み取れませんでした」。
  // 知らないキー(appVersion など)は無視する。

  class DecodeError extends Error {}

  const UUID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
  // ISO8601DateFormatter(.withInternetDateTime)が読む形。秒の小数は読まない(アプリと同じ)
  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):?(\d{2}))$/;
  const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

  const PRECISIONS = ['exact', 'yearMonth', 'year', 'decade', 'circa', 'unknown'];
  const SEXES = ['male', 'female', 'unspecified'];
  const RELATIONSHIP_KINDS = ['biologicalParent', 'adoptiveParent', 'stepParent', 'marriage', 'commonLaw'];
  const PARTNER_STATUSES = ['active', 'dissolved'];
  const FORMER_NAME_KINDS = ['familyName', 'givenName'];

  function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }
  function fail() {
    throw new DecodeError('corrupted');
  }

  /// 必須: 無い・null は失敗。任意: 無い・null は undefined
  function field(object, key, decode, optional) {
    if (!has(object, key) || object[key] === null) {
      if (optional) return undefined;
      fail();
    }
    return decode(object[key]);
  }
  function asString(value) {
    if (typeof value !== 'string') fail();
    return value;
  }
  function asBool(value) {
    if (typeof value !== 'boolean') fail();
    return value;
  }
  function asInt(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail();
    return value;
  }
  function asDouble(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail();
    return value;
  }
  function asUUID(value) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail();
    return value.toUpperCase();  // Swift の uuidString は大文字
  }
  function asEnum(values) {
    return (value) => {
      if (typeof value !== 'string' || !values.includes(value)) fail();
      return value;
    };
  }
  /// 1970年からのミリ秒
  function asDate(value) {
    if (typeof value !== 'string') fail();
    const m = DATE_PATTERN.exec(value);
    if (!m) fail();
    const month = Number(m[2]), day = Number(m[3]);
    const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) fail();
    let ms = Date.UTC(Number(m[1]), month - 1, day, hour, minute, second);
    if (m[7] !== 'Z') {
      const sign = m[8] === '+' ? 1 : -1;
      ms -= sign * (Number(m[9]) * 60 + Number(m[10])) * 60000;
    }
    if (!Number.isFinite(ms)) fail();
    return ms;
  }
  function asBase64(value) {
    if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) fail();
    return true;  // 写真は使わない。形だけ確かめる
  }
  function asArray(decodeElement) {
    return (value) => {
      if (!Array.isArray(value)) fail();
      return value.map(decodeElement);
    };
  }

  function decodePartialDate(value) {
    if (!isObject(value)) fail();
    return {
      precision: field(value, 'precision', asEnum(PRECISIONS)),
      year: field(value, 'year', asInt, true),
      month: field(value, 'month', asInt, true),
      day: field(value, 'day', asInt, true),
      original: field(value, 'original', asString),
    };
  }

  /// FormerName。v1.0.x の name / date も読む(Snapshots.swift の後方互換デコードと同じ)
  function decodeFormerName(value) {
    if (!isObject(value)) fail();
    field(value, 'id', asUUID, true);
    const valueText = field(value, 'value', asString, true);
    const legacyName = valueText === undefined ? field(value, 'name', asString, true) : undefined;
    const period = field(value, 'period', decodePartialDate, true);
    const legacyDate = period === undefined ? field(value, 'date', decodePartialDate, true) : undefined;
    return {
      kind: field(value, 'kind', asEnum(FORMER_NAME_KINDS), true) || 'familyName',
      value: valueText !== undefined ? valueText : (legacyName !== undefined ? legacyName : ''),
      kana: field(value, 'kana', asString, true) || '',
      period: period || legacyDate || { precision: 'unknown', original: '' },
    };
  }

  function decodePerson(value) {
    if (!isObject(value)) fail();
    field(value, 'photo', asBase64, true);
    field(value, 'note', asString);  // 読むが、出さない(docs/19 §1)
    field(value, 'trashedAt', asDate, true);
    field(value, 'treeID', asUUID, true);
    return {
      id: field(value, 'id', asUUID),
      familyName: field(value, 'familyName', asString),
      givenName: field(value, 'givenName', asString),
      familyNameKana: field(value, 'familyNameKana', asString),
      givenNameKana: field(value, 'givenNameKana', asString),
      formerNames: field(value, 'formerNames', asArray(decodeFormerName)),
      sex: field(value, 'sex', asEnum(SEXES)),
      birth: field(value, 'birth', decodePartialDate),
      death: field(value, 'death', decodePartialDate),
      isLiving: field(value, 'isLiving', asBool),
      isTrashed: field(value, 'isTrashed', asBool),
      orderHint: field(value, 'orderHint', asDouble, true),
      generationOffsetHint: field(value, 'generationOffsetHint', asInt, true),
      generationOffsetHintSetAt: field(value, 'generationOffsetHintSetAt', asDate, true),
      // 強調(v1.12)。欄の無い JSON(1.11 以前の書き出し)は強調なし
      isEmphasized: field(value, 'isEmphasized', asBool, true) === true,
    };
  }

  function decodeRelationship(value) {
    if (!isObject(value)) fail();
    field(value, 'note', asString);  // 読むが、出さない
    field(value, 'trashedAt', asDate, true);
    field(value, 'treeID', asUUID, true);
    return {
      id: field(value, 'id', asUUID),
      createdAt: field(value, 'createdAt', asDate, true),
      kind: field(value, 'kind', asEnum(RELATIONSHIP_KINDS)),
      personAID: field(value, 'personAID', asUUID, true),
      personBID: field(value, 'personBID', asUUID, true),
      startDate: field(value, 'startDate', decodePartialDate),
      endDate: field(value, 'endDate', decodePartialDate),
      status: field(value, 'status', asEnum(PARTNER_STATUSES), true),
      isTrashed: field(value, 'isTrashed', asBool),
    };
  }

  function decodeTree(value) {
    if (!isObject(value)) fail();
    field(value, 'id', asUUID);
    field(value, 'createdAt', asDate);
    field(value, 'updatedAt', asDate);
    field(value, 'note', asString);  // 読むが、出さない
    field(value, 'isTrashed', asBool);
    field(value, 'trashedAt', asDate, true);
    return { title: field(value, 'title', asString) };
  }

  function decodeDocument(object) {
    if (!isObject(object)) fail();
    field(object, 'app', asString);
    field(object, 'appVersion', asString, true);
    field(object, 'appBuild', asString, true);
    field(object, 'exportedAt', asDate);
    const document = {
      formatVersion: field(object, 'formatVersion', asInt),
      tree: field(object, 'tree', decodeTree),
      persons: field(object, 'persons', asArray(decodePerson)),
      relationships: field(object, 'relationships', asArray(decodeRelationship)),
    };
    // 同じ ID の人が2人いるファイルは、並べ方が決まらないので読まない
    const seen = new Set();
    for (const person of document.persons) {
      if (seen.has(person.id)) fail();
      seen.add(person.id);
    }
    return document;
  }

  /// 文字列 → { document } | { error: 'corrupted' } | { error: 'newer', version }
  function parseExport(text) {
    let object;
    try {
      object = JSON.parse(text);
    } catch (e) {
      return { error: 'corrupted' };
    }
    // バージョンだけ先に読めれば「新しすぎる」と案内できる(アプリと同じ)
    if (isObject(object) && Number.isSafeInteger(object.formatVersion)
        && object.formatVersion > CURRENT_FORMAT_VERSION) {
      return { error: 'newer', version: object.formatVersion };
    }
    try {
      return { document: decodeDocument(object) };
    } catch (e) {
      if (e instanceof DecodeError || e instanceof RangeError) return { error: 'corrupted' };
      throw e;
    }
  }

  // MARK: - PartialDate(PartialDate.swift)

  function representativeYear(date) {
    return date.precision === 'unknown' ? undefined : date.year;
  }
  function sortKey(date) {
    const year = representativeYear(date);
    if (year === undefined) return undefined;
    return year * 10000 + (date.month !== undefined ? date.month : 6) * 100
      + (date.day !== undefined ? date.day : 15);
  }
  function shortText(date) {
    switch (date.precision) {
      case 'unknown': return '?';
      case 'exact': case 'yearMonth': case 'year':
        return date.year !== undefined ? String(date.year) : '?';
      case 'decade':
        if (date.original !== '') return date.original;
        return date.year !== undefined ? date.year + '年代' : '?';
      default:  // circa
        if (date.original !== '') return date.original;
        return date.year !== undefined ? date.year + '頃' : '?';
    }
  }
  function shortYearText(date) {
    switch (date.precision) {
      case 'exact': case 'yearMonth': case 'year':
        return date.year !== undefined ? date.year + '年' : '?';
      default:
        return shortText(date);
    }
  }

  // MARK: - 橋渡し(LayoutBridge.swift)

  function isUnnamed(person) {
    return person.familyName === '' && person.givenName === '';
  }
  function displayName(person) {
    return isUnnamed(person) ? '(名前未設定)' : person.familyName + person.givenName;
  }
  function lifespanText(person) {
    const birthText = person.birth.precision === 'unknown' ? '' : shortYearText(person.birth);
    const deathText = person.death.precision === 'unknown' ? '' : shortYearText(person.death);
    if (person.isLiving) return birthText === '' ? '' : birthText + '〜';
    if (birthText === '' && deathText === '') return '没';
    return (birthText === '' ? '?' : birthText) + '〜' + (deathText === '' ? '?' : deathText);
  }

  /// LayoutInputBuilder.make。**ゴミ箱の人と、ゴミ箱のつながり・端点がゴミ箱(または見つからない)のつながりを除く**
  function buildLayoutInput(document, now) {
    const active = new Set();
    for (const person of document.persons) {
      if (!person.isTrashed) active.add(person.id);
    }
    const persons = document.persons
      .filter((person) => !person.isTrashed)
      .map((person) => ({
        id: person.id,
        label: displayName(person),
        sublabel: lifespanText(person),
        birthSortKey: sortKey(person.birth),
        birthYearIsApproximate: person.birth.precision === 'decade' || person.birth.precision === 'circa',
        orderHint: person.orderHint,
        generationOffsetHint: person.generationOffsetHint,
        generationOffsetHintSetAt: person.generationOffsetHintSetAt,
        isPlaceholder: isUnnamed(person),
        isDeceased: !person.isLiving,
        sex: person.sex,
        isEmphasized: person.isEmphasized,
      }));
    const relationships = [];
    for (const relationship of document.relationships) {
      if (relationship.isTrashed) continue;
      const a = relationship.personAID, b = relationship.personBID;
      if (a === undefined || !active.has(a) || b === undefined || !active.has(b)) continue;
      let kind;
      switch (relationship.kind) {
        case 'biologicalParent': kind = { parentChild: 'biological' }; break;
        case 'adoptiveParent': kind = { parentChild: 'adoptive' }; break;
        case 'stepParent': kind = { parentChild: 'step' }; break;
        case 'marriage': kind = { partner: 'marriage', dissolved: relationship.status === 'dissolved' }; break;
        default: kind = { partner: 'commonLaw', dissolved: relationship.status === 'dissolved' }; break;
      }
      // 開始日があれば時系列、なければ作成日時ミリ秒(作成日時が無い古いファイルは、アプリと同じく「いま」)
      const start = sortKey(relationship.startDate);
      const createdAt = relationship.createdAt !== undefined ? relationship.createdAt : now;
      relationships.push({
        id: relationship.id, kind, a, b,
        orderKey: start !== undefined ? start : Math.trunc(createdAt),
      });
    }
    return { persons, relationships };
  }

  /// 線を引けないつながり(端点が無い・見つからない・自分自身)。ゴミ箱のものは数えない
  function countUndrawableRelationships(document) {
    const ids = new Set(document.persons.map((person) => person.id));
    const trashed = new Set(document.persons.filter((p) => p.isTrashed).map((p) => p.id));
    let count = 0;
    for (const r of document.relationships) {
      if (r.isTrashed || trashed.has(r.personAID) || trashed.has(r.personBID)) continue;
      if (r.personAID === undefined || r.personBID === undefined
          || !ids.has(r.personAID) || !ids.has(r.personBID) || r.personAID === r.personBID) {
        count += 1;
      }
    }
    return count;
  }

  // MARK: - 寸法(LayoutTypes.swift の LayoutMetrics)

  const METRICS = {
    nodeWidth: 120,
    nodeHeight: 44,
    coupleGap: 16,
    blockGap: 32,
    rowGap: 72,
    componentGap: 160,
    busChannelStep: 12,
  };

  // MARK: - 連結成分の世代整合(ComponentAlignment.swift)

  const YEARS_PER_GENERATION = 30.0;
  const MAX_OFFSET_MAGNITUDE = 10;

  /// Swift の `.rounded()`(0から遠い側へ)
  function roundHalfAwayFromZero(value) {
    return Math.sign(value) * Math.round(Math.abs(value)) + 0;
  }

  function weightedMedian(samples) {
    if (samples.length === 0) return undefined;
    const sorted = samples.slice().sort((l, r) => (l.value < r.value ? -1 : l.value > r.value ? 1 : 0));
    let total = 0.0;
    for (const sample of sorted) total += sample.weight;
    let cumulative = 0.0;
    for (const sample of sorted) {
      cumulative += sample.weight;
      if (cumulative >= total / 2) return sample.value;
    }
    return sorted[sorted.length - 1].value;
  }

  function baseComponent(memberCounts, birthKnownCounts) {
    if (memberCounts.length === 0) return undefined;
    let best = 0;
    for (let index = 1; index < memberCounts.length; index++) {
      const better = memberCounts[index] !== memberCounts[best]
        ? memberCounts[index] > memberCounts[best]
        : birthKnownCounts[index] > birthKnownCounts[best];
      if (better) best = index;
    }
    return best;
  }

  function rowOffsets(samplesByComponent, memberCounts) {
    const componentCount = samplesByComponent.length;
    const offsets = new Array(componentCount).fill(0);
    if (componentCount <= 1) return offsets;
    const birthKnownCounts = samplesByComponent.map((samples) => samples.length);
    const base = baseComponent(memberCounts, birthKnownCounts);
    if (base === undefined) return offsets;
    const baseIntercept = weightedMedian(samplesByComponent[base]);
    if (baseIntercept === undefined) return offsets;
    for (let comp = 0; comp < componentCount; comp++) {
      if (comp === base) continue;
      const hopes = samplesByComponent[comp].map((sample) => ({
        value: roundHalfAwayFromZero((sample.value - baseIntercept) / YEARS_PER_GENERATION),
        weight: sample.weight,
      }));
      const hope = weightedMedian(hopes);
      if (hope === undefined) continue;
      offsets[comp] = Math.abs(hope) <= MAX_OFFSET_MAGNITUDE ? hope + 0 : 0;
    }
    return offsets;
  }

  // MARK: - レイアウトエンジン(LayoutEngine.swift)

  const HOP_RADIUS = 5;
  const HOP_CONTROL_FACTOR = 4.0 / 3.0;

  function compareStrings(l, r) {
    return l < r ? -1 : l > r ? 1 : 0;
  }
  function compareNumbers(l, r) {
    return l < r ? -1 : l > r ? 1 : 0;
  }
  function sum(values) {
    let total = 0;
    for (const value of values) total += value;
    return total;
  }
  /// 大きな配列でも落ちない最大・最小(展開して Math.max に渡すと、数十万件で落ちる)
  function maxOf(values, fallback) {
    let best = fallback;
    for (const value of values) if (value > best) best = value;
    return best;
  }
  function minOf(values, fallback) {
    let best = fallback;
    for (const value of values) if (value < best) best = value;
    return best;
  }
  function newArray(count, make) {
    const array = new Array(count);
    for (let i = 0; i < count; i++) array[i] = make();
    return array;
  }

  function layout(input) {
    const metrics = METRICS;
    const persons = input.persons.slice().sort((l, r) => compareStrings(l.id, r.id));
    const count = persons.length;
    if (count === 0) {
      return { nodes: [], edges: [], width: 0, height: 0, crossingCount: 0, componentCount: 0,
        componentRowOffsets: [] };
    }
    const indexByID = new Map();
    persons.forEach((person, index) => indexByID.set(person.id, index));

    const parentChildEdges = [];
    const partnerEdges = [];
    for (const relationship of input.relationships.slice().sort((l, r) => compareStrings(l.id, r.id))) {
      const a = indexByID.get(relationship.a), b = indexByID.get(relationship.b);
      if (a === undefined || b === undefined || a === b) continue;
      if (relationship.kind.parentChild !== undefined) {
        parentChildEdges.push({ parent: a, child: b, kind: relationship.kind.parentChild,
          relationshipID: relationship.id });
      } else {
        partnerEdges.push({ a, b, kind: relationship.kind.partner, dissolved: relationship.kind.dissolved,
          orderKey: relationship.orderKey !== undefined ? relationship.orderKey : Infinity,
          relationshipID: relationship.id });
      }
    }

    // Step 0: 連結成分
    const component = assignComponents(count, parentChildEdges, partnerEdges);
    const componentCount = maxOf(component, -1) + 1;

    // Step 1: 世代割当。実の親がいる人へ入る養親子の辺は、世代を決めるのに使わない(v1.12。docs/04)。
    // ほかに位置を決めるつながりが無いときの位置合わせ(1-a の最後)にだけ使う
    const hasBiologicalParent = new Array(count).fill(false);
    for (const edge of parentChildEdges) if (edge.kind === 'biological') hasBiologicalParent[edge.child] = true;
    const isAlignmentOnly = (edge) => edge.kind === 'adoptive' && hasBiologicalParent[edge.child];
    const generation = assignGenerations(count, component,
      parentChildEdges.filter((edge) => !isAlignmentOnly(edge)), partnerEdges,
      parentChildEdges.filter(isAlignmentOnly));

    // Step 1.5: 連結成分の世代整合
    let appliedRowOffsets = new Array(componentCount).fill(0);
    if (componentCount > 1) {
      const samples = newArray(componentCount, () => []);
      const memberCounts = new Array(componentCount).fill(0);
      for (let index = 0; index < count; index++) {
        memberCounts[component[index]] += 1;
        const key = persons[index].birthSortKey;
        if (key === undefined) continue;
        const year = Math.trunc(key / 10000);
        samples[component[index]].push({
          value: year - YEARS_PER_GENERATION * generation[index],
          weight: persons[index].birthYearIsApproximate ? 0.5 : 1.0,
        });
      }
      const rowOffset = rowOffsets(samples, memberCounts);
      const manualOffset = new Array(componentCount).fill(undefined);
      const manualOffsetSetAt = new Array(componentCount).fill(undefined);
      for (let index = 0; index < count; index++) {
        const hint = persons[index].generationOffsetHint;
        if (hint === undefined) continue;
        const comp = component[index];
        const setAt = persons[index].generationOffsetHintSetAt;
        if (manualOffset[comp] === undefined) {
          manualOffset[comp] = hint;
          manualOffsetSetAt[comp] = setAt;
        } else if (setAt !== undefined
                   && setAt > (manualOffsetSetAt[comp] !== undefined ? manualOffsetSetAt[comp] : -Infinity)) {
          manualOffset[comp] = hint;
          manualOffsetSetAt[comp] = setAt;
        }
      }
      for (let comp = 0; comp < componentCount; comp++) {
        if (manualOffset[comp] !== undefined) rowOffset[comp] = manualOffset[comp];
      }
      appliedRowOffsets = rowOffset;
      const minRow = rowOffset.length > 0 ? minOf(rowOffset, Infinity) : 0;
      if (rowOffset.some((value) => value !== 0)) {
        for (let index = 0; index < count; index++) {
          generation[index] += rowOffset[component[index]] - minRow;
        }
      }
    }

    // Step 2: 行内並び順
    const rowsByComponent = buildBlocks(persons, count, component, componentCount, generation, partnerEdges);
    // 隣の行に無い「位置合わせだけ」の養親子の辺は、並べ替えの物差しに入れない(v1.12)
    const orderingEdges = parentChildEdges.filter((edge) =>
      !(isAlignmentOnly(edge) && generation[edge.child] - generation[edge.parent] !== 1));
    minimizeCrossings(rowsByComponent, persons, count, orderingEdges);

    // Step 3: 座標割当
    const { centerX, orderInRow } = assignCoordinates(metrics, rowsByComponent, count, generation,
      parentChildEdges);

    return buildResult(metrics, persons, count, component, componentCount, generation, centerX, orderInRow,
      rowsByComponent, parentChildEdges, partnerEdges, appliedRowOffsets);
  }

  function assignComponents(count, parentChildEdges, partnerEdges) {
    const neighbors = newArray(count, () => []);
    for (const edge of parentChildEdges) {
      neighbors[edge.parent].push(edge.child);
      neighbors[edge.child].push(edge.parent);
    }
    for (const edge of partnerEdges) {
      neighbors[edge.a].push(edge.b);
      neighbors[edge.b].push(edge.a);
    }
    const component = new Array(count).fill(-1);
    let next = 0;
    for (let start = 0; start < count; start++) {
      if (component[start] !== -1) continue;
      const queue = [start];
      component[start] = next;
      let head = 0;
      while (head < queue.length) {
        const current = queue[head];
        head += 1;
        for (const neighbor of neighbors[current]) {
          if (component[neighbor] !== -1) continue;
          component[neighbor] = next;
          queue.push(neighbor);
        }
      }
      next += 1;
    }
    return component;
  }

  function assignGenerations(count, component, parentChildEdges, partnerEdges, alignmentOnlyEdges) {
    const generation = solveGenerationEqualities(count, parentChildEdges, partnerEdges, alignmentOnlyEdges || []);

    function relaxParentChild() {
      for (let i = 0; i < Math.max(1, count); i++) {
        let changed = false;
        for (const edge of parentChildEdges) {
          if (generation[edge.child] < generation[edge.parent] + 1) {
            generation[edge.child] = generation[edge.parent] + 1;
            changed = true;
          }
        }
        if (!changed) return;
      }
    }
    relaxParentChild();

    for (let i = 0; i < Math.max(1, count); i++) {
      let changed = false;
      for (const edge of partnerEdges) {
        const deeper = Math.max(generation[edge.a], generation[edge.b]);
        if (generation[edge.a] !== deeper) { generation[edge.a] = deeper; changed = true; }
        if (generation[edge.b] !== deeper) { generation[edge.b] = deeper; changed = true; }
      }
      if (!changed) break;
      relaxParentChild();
    }

    realignRigidBlocks(count, generation, parentChildEdges, partnerEdges);

    const componentCount = maxOf(component, -1) + 1;
    const minGeneration = new Array(componentCount).fill(Infinity);
    for (let index = 0; index < count; index++) {
      minGeneration[component[index]] = Math.min(minGeneration[component[index]], generation[index]);
    }
    for (let index = 0; index < count; index++) {
      generation[index] -= minGeneration[component[index]];
    }
    return generation;
  }

  function solveGenerationEqualities(count, parentChildEdges, partnerEdges, alignmentOnlyEdges) {
    const parent = newArray(count, () => 0).map((_, i) => i);
    const offset = new Array(count).fill(0);

    function find(x) {
      const path = [];
      let node = x;
      while (parent[node] !== node) {
        path.push(node);
        node = parent[node];
      }
      const root = node;
      let accumulated = 0;
      for (let i = path.length - 1; i >= 0; i--) {
        const member = path[i];
        accumulated += offset[member];
        parent[member] = root;
        offset[member] = accumulated;
      }
      return { root, offset: x === root ? 0 : offset[x] };
    }
    function unite(a, b, delta) {
      const left = find(a);
      const right = find(b);
      if (left.root === right.root) return;
      parent[right.root] = left.root;
      offset[right.root] = left.offset + delta - right.offset;
    }

    for (const edge of parentChildEdges) unite(edge.parent, edge.child, 1);
    for (const edge of partnerEdges) unite(edge.a, edge.b, 0);
    for (const edge of alignmentOnlyEdges) unite(edge.parent, edge.child, 1);

    const result = new Array(count);
    for (let i = 0; i < count; i++) result[i] = find(i).offset;
    return result;
  }

  function realignRigidBlocks(count, generation, parentChildEdges, partnerEdges) {
    if (count <= 1 || parentChildEdges.length === 0) return;

    const blockOf = newArray(count, () => 0).map((_, i) => i);
    function blockRoot(x) {
      let node = x;
      while (blockOf[node] !== node) node = blockOf[node];
      let current = x;
      while (blockOf[current] !== node) {
        const next = blockOf[current];
        blockOf[current] = node;
        current = next;
      }
      return node;
    }
    function mergeBlocks(a, b) {
      const left = blockRoot(a), right = blockRoot(b);
      if (left !== right) blockOf[right] = left;
    }
    function buildRigidBlocks() {
      for (const edge of parentChildEdges) {
        if (generation[edge.child] === generation[edge.parent] + 1) mergeBlocks(edge.parent, edge.child);
      }
      for (const edge of partnerEdges) {
        if (generation[edge.a] === generation[edge.b]) mergeBlocks(edge.a, edge.b);
      }
    }
    buildRigidBlocks();

    for (let iteration = 0; iteration < Math.max(1, count); iteration++) {
      const allowedShift = new Array(count).fill(Infinity);
      const hasChildAnchor = new Array(count).fill(false);
      for (const edge of parentChildEdges) {
        const parentBlock = blockRoot(edge.parent);
        if (parentBlock === blockRoot(edge.child)) continue;
        const slack = generation[edge.child] - generation[edge.parent] - 1;
        allowedShift[parentBlock] = Math.min(allowedShift[parentBlock], Math.max(0, slack));
        hasChildAnchor[parentBlock] = true;
      }
      for (const edge of partnerEdges) {
        const blockA = blockRoot(edge.a), blockB = blockRoot(edge.b);
        if (blockA === blockB) continue;
        allowedShift[blockA] = Math.min(allowedShift[blockA], Math.max(0, generation[edge.b] - generation[edge.a]));
        allowedShift[blockB] = Math.min(allowedShift[blockB], Math.max(0, generation[edge.a] - generation[edge.b]));
      }

      const shift = new Array(count).fill(0);
      let moved = false;
      for (let index = 0; index < count; index++) {
        if (blockRoot(index) !== index) continue;
        if (!hasChildAnchor[index] || allowedShift[index] === Infinity || !(allowedShift[index] > 0)) continue;
        shift[index] = allowedShift[index];
        moved = true;
      }
      if (!moved) return;
      for (let index = 0; index < count; index++) generation[index] += shift[blockRoot(index)];
      buildRigidBlocks();
    }
  }

  function blockSortKey(block, persons) {
    let best = Infinity;
    for (const member of block) {
      const key = persons[member].birthSortKey;
      if (key !== undefined && key < best) best = key;
    }
    return best;
  }
  function blockOrderHint(block, persons) {
    let best;
    for (const member of block) {
      const hint = persons[member].orderHint;
      if (hint !== undefined && (best === undefined || hint < best)) best = hint;
    }
    return best;
  }
  function applyOrderHints(row, persons) {
    const hintedSlots = [];
    row.forEach((block, index) => {
      if (blockOrderHint(block, persons) !== undefined) hintedSlots.push(index);
    });
    if (hintedSlots.length <= 1) return;
    const ordered = hintedSlots
      .map((position) => ({ block: row[position], position }))
      .sort((l, r) => {
        const lh = blockOrderHint(l.block, persons), rh = blockOrderHint(r.block, persons);
        return lh !== rh ? compareNumbers(lh, rh) : compareNumbers(l.position, r.position);
      });
    hintedSlots.forEach((slot, i) => { row[slot] = ordered[i].block; });
  }

  function buildBlocks(persons, count, component, componentCount, generation, partnerEdges) {
    const rowPartners = newArray(count, () => []);
    for (const edge of partnerEdges) {
      if (generation[edge.a] !== generation[edge.b]) continue;
      rowPartners[edge.a].push({ neighbor: edge.b, orderKey: edge.orderKey });
      rowPartners[edge.b].push({ neighbor: edge.a, orderKey: edge.orderKey });
    }
    for (let index = 0; index < count; index++) {
      rowPartners[index].sort((l, r) => (l.orderKey !== r.orderKey
        ? compareNumbers(l.orderKey, r.orderKey) : compareNumbers(l.neighbor, r.neighbor)));
    }

    const membersByComponent = newArray(componentCount, () => []);
    for (let index = 0; index < count; index++) membersByComponent[component[index]].push(index);

    const rows = [];
    for (let comp = 0; comp < componentCount; comp++) {
      const members = membersByComponent[comp];
      let maxGeneration = 0;
      if (members.length > 0) maxGeneration = maxOf(members.map((m) => generation[m]), -Infinity);
      const componentRows = newArray(maxGeneration + 1, () => []);
      const visited = new Array(count).fill(false);

      for (const person of members) {
        if (visited[person]) continue;
        const row = generation[person];
        const chain = [person];
        visited[person] = true;
        let head = 0;
        while (head < chain.length) {
          const current = chain[head];
          head += 1;
          for (const partner of rowPartners[current]) {
            if (visited[partner.neighbor]) continue;
            visited[partner.neighbor] = true;
            chain.push(partner.neighbor);
          }
        }
        if (chain.length === 1) {
          componentRows[row].push(chain);
          continue;
        }
        const chainSet = new Set(chain);
        const degree = (p) => rowPartners[p].filter((e) => chainSet.has(e.neighbor)).length;
        const endpointKey = (p) => {
          let earliest = Infinity;
          for (const e of rowPartners[p]) {
            if (chainSet.has(e.neighbor) && e.orderKey < earliest) earliest = e.orderKey;
          }
          return [earliest, p];
        };
        const endpoints = chain.filter((p) => degree(p) <= 1);
        let start;
        if (endpoints.length > 0) {
          start = endpoints[0];
          let startKey = endpointKey(start);
          for (let i = 1; i < endpoints.length; i++) {
            const key = endpointKey(endpoints[i]);
            if (key[0] < startKey[0] || (key[0] === startKey[0] && key[1] < startKey[1])) {
              start = endpoints[i];
              startKey = key;
            }
          }
        } else {
          start = chain.slice().sort(compareNumbers)[0];
        }
        const sequence = [start];
        const inSequence = new Set([start]);
        while (sequence.length < chain.length) {
          const current = sequence[sequence.length - 1];
          const next = rowPartners[current].find((e) => chainSet.has(e.neighbor) && !inSequence.has(e.neighbor));
          if (next !== undefined) {
            sequence.push(next.neighbor);
            inSequence.add(next.neighbor);
          } else {
            const remaining = chain.filter((p) => !inSequence.has(p)).sort(compareNumbers);
            for (const p of remaining) {
              sequence.push(p);
              inSequence.add(p);
            }
          }
        }
        const hintedSlots = [];
        sequence.forEach((member, index) => {
          if (persons[member].orderHint !== undefined) hintedSlots.push(index);
        });
        if (hintedSlots.length > 1) {
          const ordered = hintedSlots
            .map((position) => ({ member: sequence[position], position }))
            .sort((l, r) => {
              const lh = persons[l.member].orderHint, rh = persons[r.member].orderHint;
              return lh !== rh ? compareNumbers(lh, rh) : compareNumbers(l.position, r.position);
            });
          hintedSlots.forEach((slot, i) => { sequence[slot] = ordered[i].member; });
        }
        componentRows[row].push(sequence);
      }

      for (const row of componentRows) {
        row.sort((l, r) => {
          const lk = blockSortKey(l, persons), rk = blockSortKey(r, persons);
          return lk !== rk ? compareNumbers(lk, rk) : compareNumbers(l[0], r[0]);
        });
        applyOrderHints(row, persons);
      }
      rows.push(componentRows);
    }
    return rows;
  }

  function minimizeCrossings(rows, persons, count, parentChildEdges) {
    const parentsOf = newArray(count, () => []);
    const childrenOf = newArray(count, () => []);
    for (const edge of parentChildEdges) {
      parentsOf[edge.child].push(edge.parent);
      childrenOf[edge.parent].push(edge.child);
    }

    for (let comp = 0; comp < rows.length; comp++) {
      const componentRows = rows[comp];
      const rowCount = componentRows.length;
      if (rowCount <= 1) continue;

      const slot = new Array(count).fill(0.0);
      const updateSlots = () => {
        for (const row of componentRows) {
          let position = 0.0;
          for (const block of row) {
            for (const member of block) {
              slot[member] = position;
              position += 1;
            }
          }
        }
      };
      const sortRow = (rowIndex, neighborsOf) => {
        const row = componentRows[rowIndex];
        const keyed = row.map((block, position) => {
          const neighborSlots = [];
          for (const member of block) {
            for (const neighbor of neighborsOf[member]) neighborSlots.push(slot[neighbor]);
          }
          const currentMean = sum(block.map((m) => slot[m])) / block.length;
          const bary = neighborSlots.length === 0 ? currentMean : sum(neighborSlots) / neighborSlots.length;
          return { bary, birth: blockSortKey(block, persons), id: block[0], current: position, block };
        });
        keyed.sort((l, r) => {
          if (l.bary !== r.bary) return compareNumbers(l.bary, r.bary);
          if (l.birth !== r.birth) return compareNumbers(l.birth, r.birth);
          if (l.id !== r.id) return compareNumbers(l.id, r.id);
          return compareNumbers(l.current, r.current);
        });
        componentRows[rowIndex] = keyed.map((k) => k.block);
      };

      updateSlots();
      for (let iteration = 0; iteration < 3; iteration++) {
        for (let rowIndex = 1; rowIndex < rowCount; rowIndex++) {
          sortRow(rowIndex, parentsOf);
          applyOrderHints(componentRows[rowIndex], persons);
          updateSlots();
        }
        for (let rowIndex = rowCount - 2; rowIndex >= 0; rowIndex--) {
          sortRow(rowIndex, childrenOf);
          applyOrderHints(componentRows[rowIndex], persons);
          updateSlots();
        }
      }
    }
  }

  function assignCoordinates(metrics, rows, count, generation, parentChildEdges) {
    const parentsOf = newArray(count, () => []);
    const childrenOf = newArray(count, () => []);
    for (const edge of parentChildEdges) {
      parentsOf[edge.child].push(edge.parent);
      childrenOf[edge.parent].push(edge.child);
    }

    const centerX = new Array(count).fill(0.0);
    const orderInRow = new Array(count).fill(0);
    const nodeSpan = metrics.nodeWidth + metrics.coupleGap;
    let componentOffset = 0.0;

    for (const componentRows of rows) {
      for (const row of componentRows) {
        let order = 0;
        for (const block of row) {
          for (const member of block) {
            orderInRow[member] = order;
            order += 1;
          }
        }
      }

      const blockWidth = (block) => block.length * metrics.nodeWidth + (block.length - 1) * metrics.coupleGap;
      const memberOffset = (position, block) => (position - (block.length - 1) / 2) * nodeSpan;
      const desiredCenter = (block, neighborsOf, requireUpper, generationOf) => {
        const desires = [];
        block.forEach((member, position) => {
          const anchors = neighborsOf[member]
            .filter((n) => (requireUpper ? generation[n] < generationOf : generation[n] > generationOf))
            .map((n) => centerX[n]);
          if (anchors.length === 0) return;
          const anchor = sum(anchors) / anchors.length;
          desires.push(anchor - memberOffset(position, block));
        });
        if (desires.length === 0) return undefined;
        return sum(desires) / desires.length;
      };
      const place = (block, center) => {
        block.forEach((member, position) => { centerX[member] = center + memberOffset(position, block); });
      };

      // パス1(上から下へ)
      componentRows.forEach((row, rowGeneration) => {
        let cursor = 0.0;
        for (const block of row) {
          const width = blockWidth(block);
          const desired = desiredCenter(block, parentsOf, true, rowGeneration);
          const center = Math.max(desired !== undefined ? desired : cursor + width / 2, cursor + width / 2);
          place(block, center);
          cursor = center + width / 2 + metrics.blockGap;
        }
      });

      // パス2(下から上へ)・パス3(上から下へ)
      for (let pass = 0; pass < 2; pass++) {
        const rowIndices = [];
        for (let i = 0; i < componentRows.length; i++) rowIndices.push(i);
        if (pass === 0) rowIndices.reverse();
        for (const rowGeneration of rowIndices) {
          const row = componentRows[rowGeneration];
          const neighborsOf = pass === 0 ? childrenOf : parentsOf;
          // 左→右のあと右→左にも流す(アプリの LayoutEngine と同じ。v1.10)
          const sweep = [];
          for (let i = 0; i < row.length; i++) sweep.push(i);
          for (let i = row.length - 1; i >= 0; i--) sweep.push(i);
          sweep.forEach((blockIndex) => {
            const block = row[blockIndex];
            const desired = desiredCenter(block, neighborsOf, pass === 1, rowGeneration);
            if (desired === undefined) return;
            const width = blockWidth(block);
            let lower = -Number.MAX_VALUE;
            let upper = Number.MAX_VALUE;
            if (blockIndex > 0) {
              const previous = row[blockIndex - 1];
              lower = centerX[previous[previous.length - 1]] + metrics.nodeWidth / 2 + metrics.blockGap + width / 2;
            }
            if (blockIndex < row.length - 1) {
              const next = row[blockIndex + 1];
              upper = centerX[next[0]] - metrics.nodeWidth / 2 - metrics.blockGap - width / 2;
            }
            if (!(lower <= upper)) return;
            place(block, Math.min(Math.max(desired, lower), upper));
          });
        }
      }

      const members = [];
      for (const row of componentRows) for (const block of row) for (const m of block) members.push(m);
      if (members.length === 0) continue;
      let minX = Infinity;
      for (const m of members) minX = Math.min(minX, centerX[m] - metrics.nodeWidth / 2);
      for (const m of members) centerX[m] += componentOffset - minX;
      let maxX = -Infinity;
      for (const m of members) maxX = Math.max(maxX, centerX[m] + metrics.nodeWidth / 2);
      componentOffset = maxX + metrics.componentGap;
    }
    return { centerX, orderInRow };
  }

  const KIND_ORDER = ['biological', 'adoptive', 'step'];
  const KIND_RANK = { biological: 0, adoptive: 1, step: 2 };

  function buildResult(metrics, persons, count, component, componentCount, generation, centerX, orderInRow,
                       rowsByComponent, parentChildEdges, partnerEdges, componentRowOffsets) {
    const rowHeight = metrics.nodeHeight + metrics.rowGap;
    const topY = (p) => generation[p] * rowHeight;
    const midY = (p) => topY(p) + metrics.nodeHeight / 2;
    const bottomY = (p) => topY(p) + metrics.nodeHeight;

    const blockPosition = newArray(count, () => ({ block: -1, position: 0 }));
    let blockCounter = 0;
    for (const componentRows of rowsByComponent) {
      for (const row of componentRows) {
        for (const block of row) {
          block.forEach((member, position) => { blockPosition[member] = { block: blockCounter, position }; });
          blockCounter += 1;
        }
      }
    }
    const areAdjacentPartners = (a, b) => blockPosition[a].block === blockPosition[b].block
      && Math.abs(blockPosition[a].position - blockPosition[b].position) === 1;

    const edges = [];

    for (const edge of partnerEdges) {
      const style = edge.kind === 'marriage' ? (edge.dissolved ? 'doubleLineSlash' : 'doubleLine') : 'dashed';
      if (generation[edge.a] === generation[edge.b] && areAdjacentPartners(edge.a, edge.b)) {
        const [left, right] = centerX[edge.a] <= centerX[edge.b] ? [edge.a, edge.b] : [edge.b, edge.a];
        edges.push({ relationshipID: edge.relationshipID, style, hops: [], points: [
          { x: centerX[left] + metrics.nodeWidth / 2, y: midY(left) },
          { x: centerX[right] - metrics.nodeWidth / 2, y: midY(right) },
        ] });
      } else {
        edges.push({ relationshipID: edge.relationshipID, style, hops: [], points: [
          { x: centerX[edge.a], y: midY(edge.a) },
          { x: centerX[edge.b], y: midY(edge.b) },
        ] });
      }
    }

    const dropLines = [];

    // 親子の線は、端でない人の箱の上を通らない(v1.12。docs/04)。行を跨ぐ・同じ行・上の行の線は、
    // 親の行の下で横へ折り、ブロックの隙間(夫婦の間は通さない)を縦に通って子の行の上へ。隙間が無ければ外を回る
    const rowCenters = new Map();
    for (let person = 0; person < count; person++) {
      if (!rowCenters.has(generation[person])) rowCenters.set(generation[person], []);
      rowCenters.get(generation[person]).push(centerX[person]);
    }
    for (const centers of rowCenters.values()) centers.sort(compareNumbers);
    const laneHalfWidth = metrics.nodeWidth / 2 + 10;
    function laneX(anchorX, childX, parentGeneration, childGeneration) {
      if (childGeneration - parentGeneration === 1) return undefined;
      const crossed = [];
      if (childGeneration > parentGeneration) {
        for (let row = parentGeneration + 1; row < childGeneration; row++) crossed.push(row);
      } else {
        for (let row = childGeneration; row <= parentGeneration; row++) crossed.push(row);
      }
      const isClear = (x) => crossed.every((row) =>
        (rowCenters.get(row) || []).every((center) => Math.abs(center - x) >= laneHalfWidth));
      if (childGeneration > parentGeneration && isClear(anchorX)) return undefined;
      const candidates = [anchorX, childX];
      let outerLeft = Number.MAX_VALUE;
      let outerRight = -Number.MAX_VALUE;
      for (const row of crossed) {
        const centers = rowCenters.get(row) || [];
        for (let i = 0; i + 1 < centers.length; i++) candidates.push((centers[i] + centers[i + 1]) / 2);
        if (centers.length > 0) {
          outerLeft = Math.min(outerLeft, centers[0]);
          outerRight = Math.max(outerRight, centers[centers.length - 1]);
        }
      }
      if (outerLeft <= outerRight) {
        candidates.push(outerLeft - metrics.nodeWidth / 2 - metrics.blockGap / 2);
        candidates.push(outerRight + metrics.nodeWidth / 2 + metrics.blockGap / 2);
      }
      let best;
      for (const x of candidates) {
        if (!isClear(x)) continue;
        if (best === undefined) { best = x; continue; }
        const cost = Math.abs(x - anchorX) + Math.abs(x - childX);
        const bestCost = Math.abs(best - anchorX) + Math.abs(best - childX);
        if (cost < bestCost || (cost === bestCost && x < best)) best = x;
      }
      return best;
    }

    const parentLinks = newArray(count, () => []);
    for (const edge of parentChildEdges) {
      parentLinks[edge.child].push({ parent: edge.parent, kind: edge.kind, relationshipID: edge.relationshipID });
    }

    const groups = [];
    const groupIndexByKey = new Map();
    for (let child = 0; child < count; child++) {
      if (parentLinks[child].length === 0) continue;
      for (const kind of KIND_ORDER) {
        const links = parentLinks[child].filter((l) => l.kind === kind)
          .sort((l, r) => compareStrings(l.relationshipID, r.relationshipID));
        if (links.length === 0) continue;
        const rowKey = component[child] * 10000 + generation[child];
        const parentsKey = links.map((l) => String(l.parent)).sort().join('_');
        const key = rowKey + '|' + kind + '|' + parentsKey;

        const specs = [];
        if (links.length === 2 && areAdjacentPartners(links[0].parent, links[1].parent)
            && generation[links[0].parent] === generation[links[1].parent]) {
          specs.push({
            anchorX: (centerX[links[0].parent] + centerX[links[1].parent]) / 2,
            startY: midY(links[0].parent),
            child,
            relationshipID: links[0].relationshipID + '+' + links[1].relationshipID,
            parentGeneration: generation[links[0].parent],
            parentBottomY: bottomY(links[0].parent),
          });
        } else {
          for (const link of links) {
            specs.push({
              anchorX: centerX[link.parent],
              startY: bottomY(link.parent),
              child,
              relationshipID: link.relationshipID,
              parentGeneration: generation[link.parent],
              parentBottomY: bottomY(link.parent),
            });
          }
        }

        let index = groupIndexByKey.get(key);
        if (index === undefined) {
          index = groups.length;
          groupIndexByKey.set(key, index);
          groups.push({ rowKey, kind, childTopY: topY(child), drops: [],
            minX: Number.MAX_VALUE, maxX: -Number.MAX_VALUE, level: 0 });
        }
        for (const spec of specs) {
          const group = groups[index];
          spec.laneX = laneX(spec.anchorX, centerX[child], spec.parentGeneration, generation[child]);
          const busStart = spec.laneX !== undefined ? spec.laneX : spec.anchorX;
          group.drops.push(spec);
          group.minX = Math.min(group.minX, busStart, centerX[child]);
          group.maxX = Math.max(group.maxX, busStart, centerX[child]);
        }
      }
    }

    const assignmentOrder = groups.map((_, i) => i).sort((l, r) => {
      if (groups[l].rowKey !== groups[r].rowKey) return compareNumbers(groups[l].rowKey, groups[r].rowKey);
      if (groups[l].minX !== groups[r].minX) return compareNumbers(groups[l].minX, groups[r].minX);
      return compareNumbers(KIND_RANK[groups[l].kind], KIND_RANK[groups[r].kind]);
    });
    const trackEnds = new Map();
    const usedLevels = new Map();
    const trackMargin = metrics.blockGap / 2;
    for (const index of assignmentOrder) {
      const group = groups[index];
      const tracks = trackEnds.has(group.rowKey) ? trackEnds.get(group.rowKey) : [];
      const childKeys = new Set(group.drops.map((d) => group.rowKey + '|' + d.child));
      const blocked = new Set();
      for (const childKey of childKeys) {
        const used = usedLevels.get(childKey);
        if (used) for (const level of used) blocked.add(level);
      }
      let level = 0;
      for (;;) {
        const overlaps = level < tracks.length && tracks[level] + trackMargin > group.minX;
        if (!overlaps && !blocked.has(level)) break;
        level += 1;
      }
      while (tracks.length <= level) tracks.push(-Number.MAX_VALUE);
      tracks[level] = Math.max(tracks[level], group.maxX);
      trackEnds.set(group.rowKey, tracks);
      for (const childKey of childKeys) {
        if (!usedLevels.has(childKey)) usedLevels.set(childKey, new Set());
        usedLevels.get(childKey).add(level);
      }
      group.level = level;
    }

    const horizontals = [];
    const verticals = [];
    groups.forEach((group, groupIndex) => {
      const style = group.kind === 'biological' ? 'solid' : (group.kind === 'adoptive' ? 'dotted' : 'dashDot');
      const busY = Math.max(group.childTopY - metrics.rowGap / 2 - group.level * metrics.busChannelStep,
        group.childTopY - metrics.rowGap + 8);
      for (const spec of group.drops) {
        const childX = centerX[spec.child];
        const childTop = { x: childX, y: topY(spec.child) };
        const points = [{ x: spec.anchorX, y: spec.startY }];
        if (spec.laneX !== undefined) {
          const lane = spec.laneX;
          const detourY = spec.parentBottomY + metrics.rowGap / 4;
          const route = [
            { x: spec.anchorX, y: detourY }, { x: lane, y: detourY },
            { x: lane, y: busY }, { x: childX, y: busY },
          ];
          for (const point of route) {
            const last = points[points.length - 1];
            if (!(Math.abs(point.x - last.x) < 0.01 && Math.abs(point.y - last.y) < 0.01)) points.push(point);
          }
          verticals.push({ groupIndex, x: spec.anchorX, topYValue: spec.startY, bottomYValue: detourY });
          verticals.push({ groupIndex, x: lane, topYValue: Math.min(detourY, busY),
            bottomYValue: Math.max(detourY, busY) });
          verticals.push({ groupIndex, x: childX, topYValue: busY, bottomYValue: childTop.y });
          if (Math.abs(lane - spec.anchorX) > 0.01) {
            horizontals.push({ edgeIndex: edges.length, groupIndex, y: detourY,
              minX: Math.min(spec.anchorX, lane), maxX: Math.max(spec.anchorX, lane) });
          }
          if (Math.abs(lane - childX) > 0.01) {
            horizontals.push({ edgeIndex: edges.length, groupIndex, y: busY,
              minX: Math.min(lane, childX), maxX: Math.max(lane, childX) });
          }
        } else if (Math.abs(spec.anchorX - childX) > 0.01) {
          points.push({ x: spec.anchorX, y: busY });
          points.push({ x: childX, y: busY });
          horizontals.push({ edgeIndex: edges.length, groupIndex, y: busY,
            minX: Math.min(spec.anchorX, childX), maxX: Math.max(spec.anchorX, childX) });
          verticals.push({ groupIndex, x: spec.anchorX, topYValue: spec.startY, bottomYValue: busY });
          verticals.push({ groupIndex, x: childX, topYValue: busY, bottomYValue: childTop.y });
        } else {
          verticals.push({ groupIndex, x: spec.anchorX, topYValue: spec.startY, bottomYValue: childTop.y });
        }
        points.push(childTop);
        edges.push({ relationshipID: spec.relationshipID, style, points, hops: [] });
        dropLines.push({ anchorX: spec.anchorX, childX, childRowKey: group.rowKey,
          adjacentRows: generation[spec.child] - spec.parentGeneration === 1 });
      }
    });

    const hopEpsilon = 0.5;
    const minimumHopGap = HOP_RADIUS * 2 + 2;
    for (const horizontal of horizontals) {
      const hopXs = verticals
        .filter((v) => v.groupIndex !== horizontal.groupIndex
          && v.x > horizontal.minX + hopEpsilon
          && v.x < horizontal.maxX - hopEpsilon
          && horizontal.y > v.topYValue + hopEpsilon
          && horizontal.y < v.bottomYValue - hopEpsilon)
        .map((v) => v.x)
        .sort(compareNumbers);
      const merged = [];
      for (const x of hopXs) {
        if (merged.length === 0 || x - merged[merged.length - 1] >= minimumHopGap) merged.push(x);
      }
      if (merged.length > 0) {
        edges[horizontal.edgeIndex].hops = edges[horizontal.edgeIndex].hops
          .concat(merged.map((x) => ({ x, y: horizontal.y })));
      }
    }

    let crossingCount = 0;
    const adjacentDrops = dropLines.filter((d) => d.adjacentRows);
    for (let i = 0; i < adjacentDrops.length; i++) {
      for (let j = i + 1; j < adjacentDrops.length; j++) {
        if (adjacentDrops[i].childRowKey !== adjacentDrops[j].childRowKey) continue;
        const deltaAnchor = adjacentDrops[i].anchorX - adjacentDrops[j].anchorX;
        const deltaChild = adjacentDrops[i].childX - adjacentDrops[j].childX;
        if (deltaAnchor * deltaChild < 0) crossingCount += 1;
      }
    }

    const order = [];
    for (let i = 0; i < count; i++) order.push(i);
    order.sort((l, r) => {
      if (component[l] !== component[r]) return compareNumbers(component[l], component[r]);
      if (generation[l] !== generation[r]) return compareNumbers(generation[l], generation[r]);
      return compareNumbers(orderInRow[l], orderInRow[r]);
    });
    const nodes = order.map((index) => ({
      personID: persons[index].id, component: component[index], generation: generation[index],
      order: orderInRow[index], x: centerX[index], y: topY(index),
    }));

    let width = -Infinity, height = -Infinity;
    for (let i = 0; i < count; i++) {
      width = Math.max(width, centerX[i] + metrics.nodeWidth / 2);
      height = Math.max(height, bottomY(i));
    }
    return { nodes, edges, width, height, crossingCount, componentCount, componentRowOffsets };
  }

  // MARK: - 描画の中間表現(RenderScene.swift)

  function buildScene(result, input) {
    const personByID = new Map();
    for (const person of input.persons) personByID.set(person.id, person);
    return {
      boxes: result.nodes.map((node) => {
        const person = personByID.get(node.personID);
        return {
          personID: node.personID,
          x: node.x - METRICS.nodeWidth / 2,
          y: node.y,
          width: METRICS.nodeWidth,
          height: METRICS.nodeHeight,
          label: person ? person.label : node.personID,
          sublabel: person ? person.sublabel : '',
          isPlaceholder: person ? person.isPlaceholder : false,
          isDeceased: person ? person.isDeceased : false,
          sex: person ? person.sex : 'unspecified',
          isEmphasized: person ? person.isEmphasized : false,
        };
      }),
      lines: result.edges,
      width: result.width,
      height: result.height,
    };
  }

  /// 強調の二重の枠(v1.12)。**アプリの `EmphasisFrame` と同じ値**(golden の `emphasisFrame` で突き合わせる)
  // v1.13: 案3(縁から 5pt・2.2pt・墨色)
  const EMPHASIS_FRAME = { outset: 5, lineWidth: 2.2, cornerRadius: 8 + 5 };

  /// 外側の線の矩形(線の中心を通る。左上原点)
  function emphasisFrameRect(box) {
    const o = EMPHASIS_FRAME.outset;
    return { x: box.x - o, y: box.y - o, width: box.width + o * 2, height: box.height + o * 2,
      rx: EMPHASIS_FRAME.cornerRadius, strokeWidth: EMPHASIS_FRAME.lineWidth };
  }

  /// RenderPath.commands。ポリライン+飛越点 → 描画コマンド列
  function pathCommands(points, hops) {
    if (points.length < 2) return [];
    const result = [{ move: points[0] }];
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1];
      const to = points[index];
      if (Math.abs(from.y - to.y) < 0.001) {
        const direction = to.x >= from.x ? 1 : -1;
        const lower = Math.min(from.x, to.x) + HOP_RADIUS;
        const upper = Math.max(from.x, to.x) - HOP_RADIUS;
        const segmentHops = hops
          .filter((h) => Math.abs(h.y - from.y) < 0.001 && h.x > lower && h.x < upper)
          .sort((l, r) => (direction > 0 ? compareNumbers(l.x, r.x) : compareNumbers(r.x, l.x)));
        for (const hop of segmentHops) {
          const entry = { x: hop.x - direction * HOP_RADIUS, y: from.y };
          const exit = { x: hop.x + direction * HOP_RADIUS, y: from.y };
          result.push({ line: entry });
          result.push({ hop: { from: entry, to: exit } });
        }
      }
      result.push({ line: to });
    }
    return result;
  }

  // MARK: - 箱の塗り(BoxFill.swift。明るい表示だけ)

  const BOX_FILL = {
    unspecified: { living: [0.969, 0.961, 0.941], deceased: [0.843, 0.836, 0.819] },
    male: { living: [0.890, 0.943, 0.991], deceased: [0.765, 0.812, 0.853] },
    female: { living: [0.997, 0.918, 0.921], deceased: [0.858, 0.790, 0.793] },
  };

  function hexChannel(value) {
    // Swift の `(v * 255).rounded()`。値は 0〜1 なので 0 から遠い側 = 四捨五入
    const n = roundHalfAwayFromZero(Math.min(Math.max(value, 0), 1) * 255);
    return (n < 16 ? '0' : '') + n.toString(16);
  }
  function boxFillHex(sex, isDeceased) {
    const palette = BOX_FILL[sex] || BOX_FILL.unspecified;
    const rgb = isDeceased ? palette.deceased : palette.living;
    return '#' + hexChannel(rgb[0]) + hexChannel(rgb[1]) + hexChannel(rgb[2]);
  }

  /// 開いた JSON から、描くものを全部作る(画面に依存しない。テストもここを通る)
  function prepare(document, now) {
    const input = buildLayoutInput(document, now);
    const result = layout(input);
    const scene = buildScene(result, input);
    return { input, result, scene };
  }

  // MARK: - 年齢(AgeCalculator.swift / MemorialListBuilder.swift の text)

  function isCountable(precision) {
    return precision === 'exact' || precision === 'yearMonth' || precision === 'year';
  }
  function manAge(by, bm, bd, ey, em, ed) {
    const reached = em > bm || (em === bm && ed >= bd);
    return ey - by - (reached ? 0 : 1);
  }
  /// { kind: 'exact', man, kazoe } | { kind: 'range', manMin, manMax, kazoe } | { kind: 'hidden' }
  /// 旧暦(明治5年まで)の月日では数えない(PartialDate.forCalculation。v1.14)。
  /// アプリは明治より前を年の精度で保存するので、月日を持つ旧暦はv1.13までの「明治1〜5年」だけ
  function forCalculation(date) {
    if ((date.precision === 'exact' || date.precision === 'yearMonth')
        && /^明治(元|[1-5])年/.test(date.original || '')) {
      return { precision: 'year', year: date.year, original: date.original };
    }
    return date;
  }
  function age(rawBirth, rawDeath, isLiving, today) {
    const birth = forCalculation(rawBirth);
    const death = forCalculation(rawDeath);
    const end = isLiving
      ? { precision: 'exact', year: today.year, month: today.month, day: today.day }
      : death;
    if (!isCountable(birth.precision) || !isCountable(end.precision)
        || birth.year === undefined || end.year === undefined) {
      return { kind: 'hidden' };
    }
    const kazoe = end.year - birth.year + 1;
    if (kazoe < 1) return { kind: 'hidden' };
    const pick = (value, fallback) => (value !== undefined ? value : fallback);
    const manMax = manAge(birth.year, pick(birth.month, 1), pick(birth.day, 1),
      end.year, pick(end.month, 12), pick(end.day, 31));
    const manMinRaw = manAge(birth.year, pick(birth.month, 12), pick(birth.day, 31),
      end.year, pick(end.month, 1), pick(end.day, 1));
    if (manMax < 0) return { kind: 'hidden' };
    const manMin = Math.max(0, manMinRaw);
    if (birth.precision === 'exact' && end.precision === 'exact') return { kind: 'exact', man: manMax, kazoe };
    return { kind: 'range', manMin, manMax, kazoe };
  }
  function ageText(display, isLiving) {
    switch (display.kind) {
      case 'exact':
        return isLiving ? '満' + display.man + '歳(数え' + display.kazoe + ')'
          : '享年' + display.kazoe + '(満' + display.man + '歳)';
      case 'range': {
        const man = display.manMin === display.manMax
          ? '満' + display.manMin + '歳' : '満' + display.manMin + '〜' + display.manMax + '歳';
        return isLiving ? man + '(数え' + display.kazoe + ')' : '享年' + display.kazoe + '(' + man + ')';
      }
      default:
        return undefined;
    }
  }

  /// 詳細に出す日付(「1950年4月12日(昭和25年4月12日)」)。不明は undefined
  function dateText(rawDate) {
    // 旧暦(明治5年まで)の月日は西暦の月日として書かない(アプリの Wareki.display と同じ。v1.14)
    const date = forCalculation(rawDate);
    let text;
    const y = date.year;
    switch (date.precision) {
      case 'exact':
        text = y === undefined ? undefined
          : y + '年' + (date.month !== undefined ? date.month + '月' : '') + (date.day !== undefined ? date.day + '日' : '');
        break;
      case 'yearMonth':
        text = y === undefined ? undefined : y + '年' + (date.month !== undefined ? date.month + '月' : '');
        break;
      case 'year': text = y === undefined ? undefined : y + '年'; break;
      case 'decade': text = y === undefined ? undefined : y + '年代'; break;
      case 'circa': text = y === undefined ? undefined : y + '年頃'; break;
      default: text = undefined;
    }
    if (date.original !== '' && date.precision !== 'unknown') {
      return text === undefined ? date.original : text + '(' + date.original + ')';
    }
    return text;
  }

  /// 詳細パネルの行(見出し, 値)。**メモ・写真は出さない**
  function detailRows(person, today) {
    const rows = [];
    rows.push(['氏名', displayName(person)]);
    const kana = (person.familyNameKana + ' ' + person.givenNameKana).trim();
    if (kana !== '') rows.push(['ふりがな', kana]);
    for (const former of person.formerNames) {
      if (former.value === '' && former.kana === '') continue;
      let text = former.value;
      if (former.kana !== '') text += '(' + former.kana + ')';
      const until = dateText(former.period);
      if (until !== undefined) text += ' 〜' + until;
      rows.push([former.kind === 'givenName' ? '旧名' : '旧姓', text]);
    }
    const birth = dateText(person.birth);
    if (birth !== undefined) rows.push(['生まれ', birth]);
    if (!person.isLiving) {
      const death = dateText(person.death);
      rows.push(['没', death !== undefined ? death : '年月日不明']);
    }
    const ageLine = ageText(age(person.birth, person.death, person.isLiving, today), person.isLiving);
    if (ageLine !== undefined) rows.push([person.isLiving ? '年齢' : '享年', ageLine]);
    return rows;
  }

  // MARK: - SVG を組む(LayoutSVGRenderer.swift と同じ線種・色)
  //
  // **要素は make(名前) で作り、文字は textContent にだけ入れる。** 人の名前を属性に入れない。

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MARGIN = 32;
  const LINE_COLOR = '#5a544a';
  const LABEL_MAX_WIDTH = 110;

  function formatNumber(value) {
    return String(Math.round(value * 100) / 100);
  }

  /// 箱に収まらない名前は末尾を「…」にする(全文は詳細に出す)。全角1字=1em・半角=0.6em の見積もり
  function fitLabel(text, fontSize, maxWidth) {
    const chars = Array.from(text);
    let width = 0;
    for (let i = 0; i < chars.length; i++) {
      const code = chars[i].codePointAt(0);
      width += (code < 0x2E80 ? 0.6 : 1) * fontSize;
      if (width > maxWidth) {
        const keep = chars.slice(0, Math.max(1, i - 1)).join('');
        return keep + '…';
      }
    }
    return text;
  }

  /// 制御文字と、文字の向きを変える制御文字(見た目を偽れる)は、記号に置き換えて文字として見せる
  function visibleText(text) {
    let out = '';
    for (const ch of text) {
      const code = ch.codePointAt(0);
      const hidden = code < 0x20 || (code >= 0x7F && code < 0xA0)
        || (code >= 0x202A && code <= 0x202E) || (code >= 0x2066 && code <= 0x2069)
        || code === 0x200E || code === 0x200F || code === 0x061C;
      out += hidden ? '�' : ch;
    }
    return out;
  }

  function pathData(commands, dy) {
    const parts = [];
    for (const command of commands) {
      if (command.move) {
        parts.push('M', formatNumber(command.move.x + MARGIN), formatNumber(command.move.y + MARGIN + dy));
      } else if (command.line) {
        parts.push('L', formatNumber(command.line.x + MARGIN), formatNumber(command.line.y + MARGIN + dy));
      } else {
        const { from, to } = command.hop;
        const control = Math.abs(to.x - from.x) / 2 * HOP_CONTROL_FACTOR;
        parts.push('C', formatNumber(from.x + MARGIN), formatNumber(from.y + MARGIN + dy - control),
          formatNumber(to.x + MARGIN), formatNumber(to.y + MARGIN + dy - control),
          formatNumber(to.x + MARGIN), formatNumber(to.y + MARGIN + dy));
      }
    }
    return parts.join(' ');
  }

  /// `doc` は createElementNS を持つもの(ブラウザの document、テストでは偽の document)
  function renderSceneSVG(doc, scene) {
    const make = (name, attributes) => {
      const element = doc.createElementNS(SVG_NS, name);
      for (const key of Object.keys(attributes || {})) element.setAttribute(key, String(attributes[key]));
      return element;
    };
    const world = make('g', { class: 'world' });
    const lines = make('g', { class: 'lines' });
    world.appendChild(lines);

    for (const line of scene.lines) {
      const commands = pathCommands(line.points, line.hops);
      if (commands.length === 0) continue;
      const path = (dy, dash) => {
        const attributes = { d: pathData(commands, dy), fill: 'none', stroke: LINE_COLOR, 'stroke-width': 1.5 };
        if (dash) attributes['stroke-dasharray'] = dash;
        lines.appendChild(make('path', attributes));
      };
      switch (line.style) {
        case 'solid': path(0); break;
        case 'dotted': path(0, '2,4'); break;
        case 'dashDot': path(0, '10,4,2,4'); break;
        case 'dashed': path(0, '7,4'); break;
        case 'doubleLine': path(-1.6); path(1.6); break;
        default: {  // doubleLineSlash
          path(-1.6); path(1.6);
          const first = commands[0].move;
          const last = commands[commands.length - 1].line;
          if (first && last) {
            const midX = (first.x + last.x) / 2 + MARGIN;
            const midY = (first.y + last.y) / 2 + MARGIN;
            lines.appendChild(make('line', { x1: formatNumber(midX - 5), y1: formatNumber(midY + 7),
              x2: formatNumber(midX + 5), y2: formatNumber(midY - 7), stroke: LINE_COLOR, 'stroke-width': 1.5 }));
          }
        }
      }
    }

    const boxes = make('g', { class: 'boxes' });
    world.appendChild(boxes);
    const boxElements = [];
    for (const box of scene.boxes) {
      const x = box.x + MARGIN;
      const y = box.y + MARGIN;
      const group = make('g', { class: box.isEmphasized ? 'box emphasized' : 'box', tabindex: 0, role: 'button' });
      const title = make('title');
      title.textContent = visibleText(box.label) + (box.sublabel !== '' ? '、' + box.sublabel : '')
        + (box.isEmphasized ? '、強調' : '');
      group.appendChild(title);
      if (box.isEmphasized) {
        // 外側にもう1本、墨色の線(v1.12)。箱より先に置く(箱の塗りが内側を覆う)
        const frame = emphasisFrameRect(box);
        group.appendChild(make('rect', { x: frame.x + MARGIN, y: frame.y + MARGIN, width: frame.width,
          height: frame.height, rx: frame.rx, fill: 'none', 'stroke-width': frame.strokeWidth,
          class: 'emphasis-frame' }));
      }
      const rect = make('rect', { x, y, width: box.width, height: box.height, rx: 8,
        fill: boxFillHex(box.sex, box.isDeceased), class: box.isPlaceholder ? 'frame placeholder' : 'frame' });
      group.appendChild(rect);
      const hasSublabel = box.sublabel !== '';
      const label = make('text', { x: x + box.width / 2, y: hasSublabel ? y + 20 : y + box.height / 2 + 4.5,
        class: box.isPlaceholder ? 'label placeholder' : 'label' });
      label.textContent = fitLabel(visibleText(box.label), 13, LABEL_MAX_WIDTH);
      group.appendChild(label);
      if (hasSublabel) {
        const sub = make('text', { x: x + box.width / 2, y: y + 35, class: 'sublabel' });
        sub.textContent = fitLabel(visibleText(box.sublabel), 10, LABEL_MAX_WIDTH);
        group.appendChild(sub);
      }
      boxes.appendChild(group);
      boxElements.push({ element: group, box });
    }
    return { world, boxElements, width: scene.width + MARGIN * 2, height: scene.height + MARGIN * 2 };
  }

  // MARK: - 画面(ブラウザのときだけ)

  function startPage() {
    const doc = window.document;
    const byId = (id) => doc.getElementById(id);
    const intro = byId('intro');
    const fileInput = byId('file-input');
    const dropZone = byId('drop-zone');
    const errorBox = byId('error');
    const viewer = byId('viewer');
    const titleText = byId('tree-title');
    const noticeText = byId('tree-notice');
    const stage = byId('stage');
    const svg = byId('canvas');
    const detail = byId('detail');
    const detailList = byId('detail-list');
    const detailTitle = byId('detail-title');

    let current = null;      // { document, rendered, personByID }
    let view = { scale: 1, tx: 0, ty: 0 };
    let selected = null;

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    function clearChildren(element) {
      while (element.firstChild) element.removeChild(element.firstChild);
    }

    function today() {
      const now = new Date();
      return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
    }

    function applyView() {
      if (!current) return;
      current.rendered.world.setAttribute('transform',
        'translate(' + view.tx + ' ' + view.ty + ') scale(' + view.scale + ')');
      svg.classList.toggle('far', view.scale < 0.75);
    }

    function fit() {
      if (!current) return;
      const rect = stage.getBoundingClientRect();
      const w = current.rendered.width, h = current.rendered.height;
      const scale = Math.min(rect.width / w, rect.height / h, 1.5);
      view = { scale, tx: (rect.width - w * scale) / 2, ty: (rect.height - h * scale) / 2 };
      applyView();
    }

    function zoomAt(factor, cx, cy) {
      const next = Math.min(Math.max(view.scale * factor, 0.02), 4);
      const k = next / view.scale;
      view = { scale: next, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k };
      applyView();
    }

    function select(entry) {
      if (selected) selected.element.classList.remove('selected');
      selected = entry;
      if (!entry) {
        detail.hidden = true;
        return;
      }
      entry.element.classList.add('selected');
      const person = current.personByID.get(entry.box.personID);
      clearChildren(detailList);
      detailTitle.textContent = visibleText(displayName(person));
      for (const [heading, value] of detailRows(person, today())) {
        const dt = doc.createElement('dt');
        dt.textContent = heading;
        const dd = doc.createElement('dd');
        dd.textContent = visibleText(value);
        detailList.appendChild(dt);
        detailList.appendChild(dd);
      }
      detail.hidden = false;
    }

    function open(text) {
      errorBox.hidden = true;
      const parsed = parseExport(text);
      if (parsed.error === 'newer') return showError(MESSAGES.newer(parsed.version));
      if (parsed.error) return showError(MESSAGES.corrupted);
      let prepared;
      try {
        prepared = prepare(parsed.document, Date.now());
      } catch (e) {
        return showError(MESSAGES.corrupted);
      }
      clearChildren(svg);
      const rendered = renderSceneSVG(doc, prepared.scene);
      svg.appendChild(rendered.world);
      const personByID = new Map(parsed.document.persons.map((p) => [p.id, p]));
      current = { document: parsed.document, rendered, personByID };
      const elementToEntry = new Map(rendered.boxElements.map((entry) => [entry.element, entry]));
      current.entryFor = (target) => {
        for (let node = target; node && node !== svg; node = node.parentNode) {
          const entry = elementToEntry.get(node);
          if (entry) return entry;
        }
        return null;
      };
      for (const entry of rendered.boxElements) {
        entry.element.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(entry);
          }
        });
      }
      titleText.textContent = visibleText(parsed.document.tree.title) || '家系図';
      const undrawable = countUndrawableRelationships(parsed.document);
      noticeText.textContent = undrawable > 0
        ? '相手が見つからない・自分自身を指しているつながりが ' + undrawable + ' 件あり、図には描いていません。'
        : '';
      noticeText.hidden = undrawable === 0;
      select(null);
      intro.hidden = true;
      viewer.hidden = false;
      doc.body.classList.add('viewing');
      fit();
    }

    function readFile(file) {
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) return showError(MESSAGES.tooLarge);
      file.text().then(open, () => showError(MESSAGES.corrupted));
    }

    fileInput.addEventListener('change', () => {
      readFile(fileInput.files && fileInput.files[0]);
      fileInput.value = '';
    });
    for (const name of ['dragenter', 'dragover']) {
      doc.addEventListener(name, (event) => {
        event.preventDefault();
        dropZone.classList.add('dragging');
      });
    }
    doc.addEventListener('dragleave', (event) => {
      if (event.target === doc.documentElement || event.target === dropZone) dropZone.classList.remove('dragging');
    });
    doc.addEventListener('drop', (event) => {
      event.preventDefault();
      dropZone.classList.remove('dragging');
      const files = event.dataTransfer && event.dataTransfer.files;
      readFile(files && files[0]);
    });

    byId('fit').addEventListener('click', fit);
    byId('zoom-in').addEventListener('click', () => {
      const r = stage.getBoundingClientRect();
      zoomAt(1.4, r.width / 2, r.height / 2);
    });
    byId('zoom-out').addEventListener('click', () => {
      const r = stage.getBoundingClientRect();
      zoomAt(1 / 1.4, r.width / 2, r.height / 2);
    });
    byId('open-another').addEventListener('click', () => fileInput.click());
    byId('detail-close').addEventListener('click', () => select(null));
    window.addEventListener('resize', () => { if (current) applyView(); });

    // 指・マウスで動かす。2本指で拡大縮小。動かさずに離したら、その人の詳細
    const pointers = new Map();
    let gesture = null;
    const local = (event) => {
      const r = stage.getBoundingClientRect();
      return { x: event.clientX - r.left, y: event.clientY - r.top };
    };
    stage.addEventListener('pointerdown', (event) => {
      if (!current) return;
      stage.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, local(event));
      const points = Array.from(pointers.values());
      if (points.length === 1) {
        gesture = { kind: 'pan', start: points[0], view: Object.assign({}, view), moved: false, target: event.target };
      } else if (points.length === 2) {
        const [a, b] = points;
        gesture = { kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: Object.assign({}, view), moved: true };
      }
    });
    stage.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId, local(event));
      const points = Array.from(pointers.values());
      if (gesture.kind === 'pan' && points.length === 1) {
        const dx = points[0].x - gesture.start.x, dy = points[0].y - gesture.start.y;
        if (Math.hypot(dx, dy) > 6) gesture.moved = true;
        if (gesture.moved) {
          view = { scale: gesture.view.scale, tx: gesture.view.tx + dx, ty: gesture.view.ty + dy };
          applyView();
        }
      } else if (gesture.kind === 'pinch' && points.length >= 2) {
        const [a, b] = points;
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const scale = Math.min(Math.max(gesture.view.scale * distance / gesture.distance, 0.02), 4);
        const k = scale / gesture.view.scale;
        view = { scale, tx: mid.x - (gesture.mid.x - gesture.view.tx) * k,
          ty: mid.y - (gesture.mid.y - gesture.view.ty) * k };
        applyView();
      }
    });
    const endPointer = (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (gesture && gesture.kind === 'pan' && !gesture.moved && event.type === 'pointerup') {
        select(current.entryFor(gesture.target));
      }
      if (pointers.size === 1 && gesture && gesture.kind === 'pinch') {
        const rest = Array.from(pointers.values())[0];
        gesture = { kind: 'pan', start: rest, view: Object.assign({}, view), moved: true };
      } else if (pointers.size === 0) {
        gesture = null;
      }
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('wheel', (event) => {
      if (!current) return;
      event.preventDefault();
      const p = local(event);
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
    }, { passive: false });
  }

  // MARK: - 出口

  const api = {
    MAX_FILE_BYTES, MESSAGES, parseExport, buildLayoutInput, layout, buildScene, prepare, pathCommands,
    boxFillHex, emphasisFrameRect, renderSceneSVG, age, ageText, detailRows, dateText, countUndrawableRelationships,
    roundHalfAwayFromZero, fitLabel, visibleText,
  };
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (typeof window === 'object' && window && window.document && window.document.getElementById('stage')) {
    startPage();
  }
})();

/**
 * Semantic AST for iBATIS 2.x Mapper XML.
 *
 * These classes are the intermediate representation produced by
 * `parser/ibatis/IbatisMapperParser.js`. They deliberately do NOT wrap the
 * XML DOM/element tree — every field here is a meaningful, typed piece of
 * the iBATIS model (statement, dynamic condition, include, etc.), so that
 * downstream resolver/analyzer/converter stages never need to know XML
 * existed in the first place.
 */

class AstNode {
  constructor(type, sourceFile, sourceLine) {
    this.type = type;
    this.sourceFile = sourceFile ?? null;
    this.sourceLine = sourceLine ?? null;
  }
}

/** Root of one parsed Mapper XML file (`<sqlMap>`). */
export class SqlMapNode extends AstNode {
  constructor({ namespace, sourceFile, sourceLine }) {
    super('SqlMap', sourceFile, sourceLine);
    this.namespace = namespace;
    /** @type {StatementNode[]} */
    this.statements = [];
    /** @type {SqlFragmentNode[]} */
    this.sqlFragments = [];
    /** @type {ResultMapNode[]} */
    this.resultMaps = [];
    /** @type {ParameterMapNode[]} */
    this.parameterMaps = [];
    /** @type {CacheModelNode[]} */
    this.cacheModels = [];
  }
}

/** `<select>` / `<insert>` / `<update>` / `<delete>` / `<procedure>`. */
export class StatementNode extends AstNode {
  constructor({
    id,
    statementType,
    parameterClass = null,
    parameterMap = null,
    resultClass = null,
    resultMap = null,
    cacheModel = null,
    fetchSize = null,
    timeout = null,
    remapResults = false,
    sourceFile,
    sourceLine,
  }) {
    super('Statement', sourceFile, sourceLine);
    this.id = id;
    this.statementType = statementType;
    this.parameterClass = parameterClass;
    this.parameterMap = parameterMap;
    this.resultClass = resultClass;
    this.resultMap = resultMap;
    this.cacheModel = cacheModel;
    this.fetchSize = fetchSize;
    this.timeout = timeout;
    this.remapResults = remapResults;
    /** @type {AstNode[]} Mixed SQL-content children (Text/Dynamic/Conditional/Iterate/Include/SelectKey). */
    this.children = [];
  }
}

/** `<sql id="...">` - a reusable SQL fragment referenced via `<include refid>`. */
export class SqlFragmentNode extends AstNode {
  constructor({ id, sourceFile, sourceLine }) {
    super('SqlFragment', sourceFile, sourceLine);
    this.id = id;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

/** Raw literal SQL text between tags. */
export class TextSqlNode extends AstNode {
  constructor({ text, sourceFile, sourceLine }) {
    super('TextSql', sourceFile, sourceLine);
    this.text = text;
  }
}

/** `<dynamic prepend="WHERE">...</dynamic>`. */
export class DynamicNode extends AstNode {
  constructor({ prepend = null, open = null, close = null, trim = null, sourceFile, sourceLine }) {
    super('Dynamic', sourceFile, sourceLine);
    this.prepend = prepend;
    /** iBATIS `open`/`close`: rendered around the body, only when the body is non-empty */
    this.open = open;
    this.close = close;
    /**
     * A MyBatis `<where>` / `<set>` / `<trim>` read for analysis (parser/mybatis):
     * `{ prefix, suffix, prefixOverrides: string[], suffixOverrides: string[] }`.
     * The body's leading / trailing override is dropped, then prefix / suffix
     * added — only when the body is non-empty. Null for iBATIS's own `<dynamic>`.
     */
    this.trim = trim;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

/** Standardized `isXxx` conditional tag (isNull, isEqual, isGreaterThan, ...). */
export class ConditionalNode extends AstNode {
  constructor({
    conditionType,
    property = null,
    compareValue = null,
    compareProperty = null,
    prepend = null,
    open = null,
    close = null,
    removeFirstPrepend = false,
    test = null,
    sourceFile,
    sourceLine,
  }) {
    super('Conditional', sourceFile, sourceLine);
    this.conditionType = conditionType;
    this.property = property;
    this.compareValue = compareValue;
    /** compare against another parameter property instead of a literal (`compareProperty="prevStatCd"`) */
    this.compareProperty = compareProperty;
    this.prepend = prepend;
    this.open = open;
    this.close = close;
    /** drop the first nested tag's own prepend (iBATIS `removeFirstPrepend="true"`) */
    this.removeFirstPrepend = removeFirstPrepend;
    /** MyBatis OGNL `test` (conditionType TEST / WHEN), read for analysis from a MyBatis mapper */
    this.test = test;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

/** `<iterate property="ids" open="(" close=")" conjunction=",">`. */
export class IterateNode extends AstNode {
  constructor({
    property = null,
    open = null,
    close = null,
    conjunction = null,
    prepend = null,
    sourceFile,
    sourceLine,
  }) {
    super('Iterate', sourceFile, sourceLine);
    this.property = property;
    this.open = open;
    this.close = close;
    this.conjunction = conjunction;
    this.prepend = prepend;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

/** `<include refid="...">`. refid is stored verbatim; resolution happens in the reference resolver. */
export class IncludeNode extends AstNode {
  constructor({ refid, sourceFile, sourceLine }) {
    super('Include', sourceFile, sourceLine);
    this.refid = refid;
  }
}

/**
 * `<selectKey keyProperty="..." resultClass="..." type="pre|post">`.
 * Note: the iBATIS `type` attribute (pre/post) is exposed as `timing`, not
 * `type` — `type` is reserved on every AST node as the node-kind
 * discriminator (`"SelectKey"` here).
 */
export class SelectKeyNode extends AstNode {
  constructor({
    keyProperty = null,
    resultClass = null,
    timing = 'post',
    sourceFile,
    sourceLine,
  }) {
    super('SelectKey', sourceFile, sourceLine);
    this.keyProperty = keyProperty;
    this.resultClass = resultClass;
    this.timing = timing;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

/** `<resultMap id="..." class="..." extends="...">`. */
export class ResultMapNode extends AstNode {
  constructor({ id, class: className = null, extends: extendsId = null, groupBy = null, sourceFile, sourceLine }) {
    super('ResultMap', sourceFile, sourceLine);
    this.id = id;
    this.class = className;
    this.extends = extendsId;
    /** iBATIS N+1-avoiding grouping: comma-separated property names that identify one parent row */
    this.groupBy = groupBy;
    /** Resolved by the reference resolver once `extends` is looked up. */
    this.resolvedParent = null;
    /** @type {ResultNode[]} */
    this.results = [];
  }
}

/** `<result property="..." column="..." .../>`. */
export class ResultNode extends AstNode {
  constructor({
    property,
    column = null,
    jdbcType = null,
    javaType = null,
    typeHandler = null,
    nullValue = null,
    select = null,
    resultMap = null,
    sourceFile,
    sourceLine,
  }) {
    super('Result', sourceFile, sourceLine);
    /** nested resultMap id (`<result property="items" resultMap="ns.item"/>`) */
    this.resultMap = resultMap;
    this.property = property;
    this.column = column;
    this.jdbcType = jdbcType;
    this.javaType = javaType;
    this.typeHandler = typeHandler;
    this.nullValue = nullValue;
    this.select = select;
  }
}

/** `<parameterMap id="..." class="...">`. */
export class ParameterMapNode extends AstNode {
  constructor({ id, class: className = null, sourceFile, sourceLine }) {
    super('ParameterMap', sourceFile, sourceLine);
    this.id = id;
    this.class = className;
    /** @type {ParameterNode[]} */
    this.parameters = [];
  }
}

/** `<parameter property="..." .../>`. */
export class ParameterNode extends AstNode {
  constructor({
    property,
    jdbcType = null,
    javaType = null,
    typeHandler = null,
    nullValue = null,
    mode = null,
    sourceFile,
    sourceLine,
  }) {
    super('Parameter', sourceFile, sourceLine);
    this.property = property;
    this.jdbcType = jdbcType;
    this.javaType = javaType;
    this.typeHandler = typeHandler;
    this.nullValue = nullValue;
    this.mode = mode;
  }
}

/** `<cacheModel id="..." type="...">` (minimal support). */
export class CacheModelNode extends AstNode {
  constructor({ id, cacheType = null, sourceFile, sourceLine }) {
    super('CacheModel', sourceFile, sourceLine);
    this.id = id;
    this.cacheType = cacheType;
  }
}

/**
 * Placeholder produced by the reference resolver in place of an
 * `<include>` that could not be resolved (missing or circular refid).
 * Kept in the `ast/ibatis` package because it only ever appears inside a
 * resolved iBATIS tree, never in the original parser output.
 */
export class UnresolvedIncludeNode extends AstNode {
  constructor({ refid, reason, path = null, sourceFile, sourceLine }) {
    super('UnresolvedInclude', sourceFile, sourceLine);
    this.refid = refid;
    /** 'MISSING' | 'CIRCULAR' */
    this.reason = reason;
    this.path = path;
  }
}

/**
 * Produced by the reference resolver to replace a resolved `<include>` in
 * the resolved tree. Keeps the original refid alongside the flattened,
 * recursively-resolved content of the referenced SQL fragment.
 */
export class ResolvedIncludeNode extends AstNode {
  constructor({ refid, qualifiedId, sourceFile, sourceLine }) {
    super('ResolvedInclude', sourceFile, sourceLine);
    this.refid = refid;
    this.qualifiedId = qualifiedId;
    /** @type {AstNode[]} recursively resolved children of the referenced fragment */
    this.children = [];
  }
}

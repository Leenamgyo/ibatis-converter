/**
 * Semantic AST for MyBatis 3.x Mapper XML. Two producers: the conversion
 * target (`converter/mybatis`), and a project's own MyBatis mappers read
 * as input (`parser/mybatis`). Rendered to XML by `generator/xml`.
 */

class AstNode {
  constructor(type) {
    this.type = type;
  }
}

export class MapperNode extends AstNode {
  constructor({ namespace }) {
    super('Mapper');
    this.namespace = namespace;
    /** @type {StatementNode[]} */
    this.statements = [];
    /** @type {SqlFragmentNode[]} */
    this.sqlFragments = [];
    /** @type {ResultMapNode[]} */
    this.resultMaps = [];
  }
}

export class StatementNode extends AstNode {
  constructor({ id, statementType, parameterType = null, resultType = null, resultMap = null }) {
    super('Statement');
    this.id = id;
    this.statementType = statementType; // SELECT | INSERT | UPDATE | DELETE
    this.parameterType = parameterType;
    this.resultType = resultType;
    this.resultMap = resultMap;
    /** a stored-procedure call: rendered with statementType="CALLABLE" */
    this.callable = false;
    /**
     * Attributes read from a MyBatis input mapper that the model has no field
     * for (useGeneratedKeys, keyProperty, fetchSize, flushCache, ...): kept as
     * `[name, value]` pairs and written back unchanged.
     */
    this.otherAttributes = [];
    /** @type {AstNode[]} */
    this.children = [];
  }
}

export class SqlFragmentNode extends AstNode {
  constructor({ id }) {
    super('SqlFragment');
    this.id = id;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

export class TextSqlNode extends AstNode {
  constructor({ text }) {
    super('TextSql');
    this.text = text;
  }
}

export class IfNode extends AstNode {
  constructor({ test }) {
    super('If');
    this.test = test;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

/** `<choose>`: its `<when>` branches in order, then an optional `<otherwise>`. */
export class ChooseNode extends AstNode {
  constructor() {
    super('Choose');
    /** @type {(WhenNode|OtherwiseNode)[]} */
    this.children = [];
  }
}

export class WhenNode extends AstNode {
  constructor({ test }) {
    super('When');
    this.test = test;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

export class OtherwiseNode extends AstNode {
  constructor() {
    super('Otherwise');
    /** @type {AstNode[]} */
    this.children = [];
  }
}

/** `<bind name="..." value="..."/>`: an OGNL variable, no SQL of its own. */
export class BindNode extends AstNode {
  constructor({ name, value }) {
    super('Bind');
    this.name = name;
    this.value = value;
  }
}

export class WhereNode extends AstNode {
  constructor() {
    super('Where');
    /** @type {AstNode[]} */
    this.children = [];
  }
}

export class SetNode extends AstNode {
  constructor() {
    super('Set');
    /** @type {AstNode[]} */
    this.children = [];
  }
}

export class TrimNode extends AstNode {
  constructor({ prefix = null, suffix = null, prefixOverrides = null, suffixOverrides = null }) {
    super('Trim');
    this.prefix = prefix;
    this.suffix = suffix;
    this.prefixOverrides = prefixOverrides;
    this.suffixOverrides = suffixOverrides;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

export class ForeachNode extends AstNode {
  constructor({ collection, item = 'item', index = null, open = null, close = null, separator = null }) {
    super('Foreach');
    this.collection = collection;
    this.item = item;
    this.index = index;
    this.open = open;
    this.close = close;
    this.separator = separator;
    /** @type {AstNode[]} */
    this.children = [];
  }
}

export class IncludeNode extends AstNode {
  constructor({ refid }) {
    super('Include');
    this.refid = refid;
  }
}

export class SelectKeyNode extends AstNode {
  constructor({ keyProperty = null, resultType = null, order = 'AFTER' }) {
    super('SelectKey');
    this.keyProperty = keyProperty;
    this.resultType = resultType;
    this.order = order; // BEFORE | AFTER
    /** @type {AstNode[]} */
    this.children = [];
  }
}

export class ResultMapNode extends AstNode {
  /**
   * Note: MyBatis's own attribute is literally named `type` (the mapped
   * Java class), but every AST node reserves `type` for the node-kind
   * discriminator (`"ResultMap"` here) — exposed as `resultType` instead,
   * same fix as `ast/ibatis`'s `SelectKeyNode.timing`.
   */
  constructor({ id, resultType = null, extendsId = null }) {
    super('ResultMap');
    this.id = id;
    this.resultType = resultType;
    this.extendsId = extendsId;
    /** @type {(IdNode|ResultNode|AssociationNode|CollectionNode)[]} */
    this.results = [];
  }
}

/** `<id>` — a `<result>` that also identifies the row (MyBatis groups nested results by it). */
export class IdNode extends AstNode {
  constructor({ property, column = null, jdbcType = null, javaType = null }) {
    super('Id');
    this.property = property;
    this.column = column;
    this.jdbcType = jdbcType;
    this.javaType = javaType;
  }
}

/** `<association>` — one nested object, from a nested resultMap or a nested select. */
export class AssociationNode extends AstNode {
  constructor({ property, column = null, javaType = null, resultMap = null, select = null }) {
    super('Association');
    this.property = property;
    this.column = column;
    this.javaType = javaType;
    this.resultMap = resultMap;
    this.select = select;
  }
}

/** `<collection>` — a nested list, from a nested resultMap (grouped rows) or a nested select. */
export class CollectionNode extends AstNode {
  constructor({ property, column = null, javaType = null, ofType = null, resultMap = null, select = null }) {
    super('Collection');
    this.property = property;
    this.column = column;
    this.javaType = javaType;
    this.ofType = ofType;
    this.resultMap = resultMap;
    this.select = select;
  }
}

export class ResultNode extends AstNode {
  constructor({ property, column = null, jdbcType = null, javaType = null, typeHandler = null }) {
    super('Result');
    this.property = property;
    this.column = column;
    this.jdbcType = jdbcType;
    this.javaType = javaType;
    this.typeHandler = typeHandler;
  }
}

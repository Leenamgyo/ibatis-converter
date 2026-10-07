package com.example.migration.model;

/**
 * Backs {@code parameterClass}/{@code resultMap class} bindings in
 * {@code test/fixtures/complex/order.xml} (see docs/AST_REFERENCE.md for
 * how iBATIS resolves #property# / <result property=".."> against JavaBean
 * getters/setters by reflection - this class exists purely as a readable
 * cross-reference for that binding, it is not compiled or executed by this
 * Node.js project).
 */
public class OrderDetail extends Order {

    private java.util.Date orderedAt;
    private String username;

    public java.util.Date getOrderedAt() {
        return orderedAt;
    }

    public void setOrderedAt(java.util.Date orderedAt) {
        this.orderedAt = orderedAt;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }
}

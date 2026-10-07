package com.example.migration.model;

/**
 * Backs {@code parameterClass}/{@code resultMap class} bindings in
 * {@code test/fixtures/complex/returnRequest.xml} (see docs/AST_REFERENCE.md for
 * how iBATIS resolves #property# / <result property=".."> against JavaBean
 * getters/setters by reflection - this class exists purely as a readable
 * cross-reference for that binding, it is not compiled or executed by this
 * Node.js project).
 */
public class ReturnRequestDetail extends ReturnRequest {

    private String productName;
    private String username;

    public String getProductName() {
        return productName;
    }

    public void setProductName(String productName) {
        this.productName = productName;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }
}

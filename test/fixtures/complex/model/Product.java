package com.example.migration.model;

/**
 * Backs {@code parameterClass}/{@code resultMap class} bindings in
 * {@code test/fixtures/complex/product.xml} (see docs/AST_REFERENCE.md for
 * how iBATIS resolves #property# / <result property=".."> against JavaBean
 * getters/setters by reflection - this class exists purely as a readable
 * cross-reference for that binding, it is not compiled or executed by this
 * Node.js project).
 */
public class Product {

    private Long categoryId;
    private java.math.BigDecimal price;
    private Long productId;
    private String productName;
    private String status;
    private Long supplierId;

    public Long getCategoryId() {
        return categoryId;
    }

    public void setCategoryId(Long categoryId) {
        this.categoryId = categoryId;
    }

    public java.math.BigDecimal getPrice() {
        return price;
    }

    public void setPrice(java.math.BigDecimal price) {
        this.price = price;
    }

    public Long getProductId() {
        return productId;
    }

    public void setProductId(Long productId) {
        this.productId = productId;
    }

    public String getProductName() {
        return productName;
    }

    public void setProductName(String productName) {
        this.productName = productName;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Long getSupplierId() {
        return supplierId;
    }

    public void setSupplierId(Long supplierId) {
        this.supplierId = supplierId;
    }
}

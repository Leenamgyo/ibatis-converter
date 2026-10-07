package com.example.migration.model;

/**
 * Backs {@code parameterClass}/{@code resultMap class} bindings in
 * {@code test/fixtures/complex/auth.xml} (see docs/AST_REFERENCE.md for
 * how iBATIS resolves #property# / <result property=".."> against JavaBean
 * getters/setters by reflection - this class exists purely as a readable
 * cross-reference for that binding, it is not compiled or executed by this
 * Node.js project).
 */
public class LoginHistory {

    private String ipAddress;
    private java.util.Date loginAt;
    private Long loginId;
    private boolean success;
    private Long userId;

    public String getIpAddress() {
        return ipAddress;
    }

    public void setIpAddress(String ipAddress) {
        this.ipAddress = ipAddress;
    }

    public java.util.Date getLoginAt() {
        return loginAt;
    }

    public void setLoginAt(java.util.Date loginAt) {
        this.loginAt = loginAt;
    }

    public Long getLoginId() {
        return loginId;
    }

    public void setLoginId(Long loginId) {
        this.loginId = loginId;
    }

    public boolean isSuccess() {
        return success;
    }

    public void setSuccess(boolean success) {
        this.success = success;
    }

    public Long getUserId() {
        return userId;
    }

    public void setUserId(Long userId) {
        this.userId = userId;
    }
}

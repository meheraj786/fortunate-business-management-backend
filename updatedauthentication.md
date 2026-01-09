# Authentication and Authorization Plan

This document outlines the comprehensive authentication and authorization strategy implemented in the backend, designed to provide secure and flexible access control for various user roles and system modules.

## 1. Core Authentication Mechanism

The system primarily utilizes **cookie-based authentication** for managing user sessions.

### 1.1 Login Process (`/api/v1/user/login`)

1.  **Client Request:** A user sends their credentials (email, password) to the `/api/v1/user/login` endpoint.
2.  **Server Verification:** The backend verifies these credentials against the stored user data.
3.  **Token Generation:** Upon successful authentication, a JSON Web Token (JWT) is generated. This JWT contains essential user information (e.g., `_id`, `email`, `role`).
4.  **Cookie Setting:** Instead of sending the JWT directly in the response body, the server sets an `accessToken` cookie in the user's browser with the generated JWT.
    *   **`httpOnly: true`**: This crucial security flag ensures that the `accessToken` cookie cannot be accessed or manipulated by client-side JavaScript. This mitigates risks from Cross-Site Scripting (XSS) attacks, as an attacker's script cannot read the token.
    *   **`secure: true`**: The cookie will only be sent over encrypted HTTPS connections. This prevents Man-in-the-Middle attacks from intercepting the token. For development environments where `sameSite: "none"` is used, `secure: true` is explicitly enforced to ensure browser compliance and proper cookie transmission.
    *   **`sameSite: "none"`**: This setting allows the cookie to be sent with cross-site requests. This is particularly important when your frontend and backend are hosted on different domains or ports (e.g., frontend on `localhost:3001` and backend on `localhost:3000`). It's always used in conjunction with `secure: true`.

### 1.2 Subsequent Requests

1.  **Automatic Cookie Transmission:** For every subsequent request to the backend (e.g., fetching a profile, accessing protected resources), the browser automatically includes the `accessToken` cookie.
2.  **`authenticate` Middleware:** The `authenticate` middleware (`middleware/auth.middleware.js`) intercepts these requests. It extracts the `accessToken` from the incoming cookie, verifies its authenticity and expiration, and if valid, attaches the decoded user payload (e.g., `_id`, `email`, `role`) to the `req.user` object. This `req.user` object then becomes available to all subsequent middleware and controller functions in the request pipeline.
3.  **Session Persistence:** As long as a valid `accessToken` cookie is present and unexpired, the user remains "logged in". Reloading the browser or navigating to different parts of the application will maintain the authenticated state because the cookie is automatically sent.

### 1.3 Logout Process (`/api/v1/user/logout`)

1.  **Client Request:** A user requests to log out.
2.  **Server Action:** The backend's `logoutUser` function clears the `accessToken` cookie from the user's browser, effectively ending their session.

## 2. Comprehensive Authorization Mechanism

The system employs a robust **Role-Based Access Control (RBAC)** enhanced with **Permission-Based Authorization**. This allows for fine-grained control over what actions users can perform based on both their assigned role and specific permissions.

### 2.1 Key Concepts

*   **Roles:** Broad categories of users (e.g., "SUPER_ADMIN", "MANAGER", "Accountant"). Defined in `models/user.model.js` within the `roleName` enum.
*   **Modules:** Logical groupings of features or resources within the application (e.g., "USER", "WAREHOUSE", "PRODUCT", "TRANSACTION"). Defined in `utils/permissions.constants.js` within the `MODULES` array. These correspond to the `module` field in the user's `access` array.
*   **Permissions:** Specific actions a user can perform within a module (e.g., `PRODUCT_CREATE`, `LC_VIEW_DETAILS`, `TRASH_DELETE_TRANSACTION`). Defined as individual constants in `utils/permissions.constants.js` within the `PERMISSIONS` object.
*   **User Access (`user.access` array):** Each user object in `models/user.model.js` has an `access` array. This array specifies which modules a user has access to, and within each module, a list of specific permissions the user holds.
*   **Bundled Permissions:** Some permissions might automatically grant other related permissions (e.g., `LC_VIEW_DETAILS` might implicitly grant `LC_EXPORT_PDF`). These relationships are defined in `utils/permissions.constants.js` within the `BUNDLED_PERMISSIONS` object and are applied during user updates (e.g., in `controllers/user.controller.js:updateUser`).

### 2.2 Authorization Middlewares (`middleware/authorize.middleware.js`)

These middlewares are applied in route definitions *after* the `authenticate` middleware, ensuring that only authenticated users proceed to authorization checks.

1.  **`authorizeRole(requiredRole)`:**
    *   **Purpose:** Restricts access based on the user's `roleName`.
    *   **Behavior:** Checks if `req.user.roleName` matches `requiredRole`. `SUPER_ADMIN` and `ADMIN` roles typically bypass these checks for full access.
    *   **Example Usage:** `authorizeRole("SUPER_ADMIN")`

2.  **`authorize(requiredPermission)`:**
    *   **Purpose:** Restricts access based on whether the user has a specific granular permission.
    *   **Behavior:** Iterates through `req.user.access` to check if `requiredPermission` exists within the user's granted permissions for any module. `SUPER_ADMIN` and `ADMIN` roles bypass these checks.
    *   **Example Usage:** `authorize(PERMISSIONS.PRODUCT_CREATE)`

3.  **`authorizeWarehouseAccess(requiredPermission)`:**
    *   **Purpose:** Specifically for warehouse-related operations, it first checks if the user is authorized for the specific `warehouseId` (passed as a URL parameter) and then checks for the `requiredPermission`.
    *   **Behavior:** Validates if `warehouseId` (from `req.params`) is present in `req.user.warehouse`. Then, it performs a `requiredPermission` check similar to `authorize`.
    *   **Example Usage:** `authorizeWarehouseAccess(PERMISSIONS.PRODUCT_UPDATE)` on a route like `/warehouses/:warehouseId/products/:productId`.

4.  **`authorizeTrashAccess(action)`:**
    *   **Purpose:** Dynamically constructs and checks specific trash-related permissions based on the requested `action` (e.g., "VIEW", "RESTORE", "DELETE") and the `model` (e.g., "LC", "PRODUCT") being managed (from `req.params`).
    *   **Behavior:** Forms a permission string like `TRASH_VIEW_LC` and then performs a permission check similar to `authorize`.
    *   **Example Usage:** `authorizeTrashAccess("DELETE")` on a route like `/trash/:model/:id`.

## 3. Key Components and Their Interactions

*   **`models/user.model.js`**: Defines the user schema, including `roleName`, `access` array (listing modules and their associated permissions), and `warehouse` array (for user-specific warehouse assignments).
*   **`utils/permissions.constants.js`**: Centralized definition for all `PERMISSIONS` strings and the `MODULES` array. This file is critical for maintaining consistency across authorization logic and frontend displays.
*   **`middleware/auth.middleware.js`**: Handles authentication by verifying the `accessToken` cookie.
*   **`middleware/authorize.middleware.js`**: Contains the core authorization logic (role-based, permission-based, warehouse-specific, trash-specific).
*   **`controllers/user.controller.js`**: Manages user login, logout, profile fetching, and updating, including handling bundled permissions during user updates.
*   **`routes/api/*.js` files**: Each module's API routes (e.g., `user.api.js`, `warehouse.api.js`, `product.api.js`) applies the `authenticate` and appropriate `authorize` middlewares to protect its endpoints.
*   **`routes/api/index.js`**: Aggregates all individual API routes under `/api/v1` and mounts new endpoints like `/api/v1/permissions`.

## 4. Frontend Interaction Guidelines

### 4.1 Authenticated Requests

*   **Automatic Cookie Handling:** Due to `httpOnly` and `secure` cookie settings, the browser will automatically include the `accessToken` cookie with all requests to the backend originating from the same domain (or cross-site if `sameSite: "none"` is properly configured with HTTPS). The frontend does **not** need to manually manage or send this token in HTTP headers.
*   **Error Handling:** The frontend should be prepared to handle `401 Unauthorized` responses (if the token is missing or invalid) or `403 Forbidden` responses (if the user lacks the necessary role/permission).

### 4.2 Dynamic Permission Display

*   **Master Permission List Endpoint (`GET /api/v1/permissions`):** The frontend should call this new API endpoint to dynamically retrieve the comprehensive list of `PERMISSIONS` and `MODULES`. This ensures that UI elements for assigning permissions (e.g., checkboxes in a SUPER_ADMIN panel) always reflect the backend's current authorization structure. This eliminates the need for hardcoding permissions in the frontend, preventing discrepancies when the backend's permissions evolve.

### 4.3 Warehouse Filtering for Non-SUPER_ADMIN Users

*   **Client-Side Filtering:** When a non-`SUPER_ADMIN` user accesses "Stock Management" or similar pages, the frontend should:
    1.  Call `GET /api/v1/warehouse` to retrieve all active warehouses.
    2.  Filter this list on the client-side based on the warehouses assigned to the currently logged-in user (available in `req.user.warehouse` on the backend, which would typically be part of the `/user/get-profile` response).
    *   **Note:** While functional, a backend endpoint that directly returns user-specific warehouses would be more efficient for large datasets.

### 4.4 Creating Products in a Specific Warehouse

*   **Nested URL Structure:** When creating a new product from within a specific warehouse's context, the frontend should make the API call to `POST /api/v1/warehouses/:warehouseId/products`, where `:warehouseId` is the ID of the warehouse the user is currently viewing. The `warehouseId` should **not** be included in the request body.

## 5. Current Status & Next Steps

*   The core authentication (cookie-based) and authorization (role/permission-based) mechanisms are in place.
*   The API for dynamically fetching permissions (`GET /api/v1/permissions`) has been implemented.
*   The `loginUser` response structure has been made consistent with `getProfile`.
*   The `TRANSACTION` module has been correctly integrated into the permission system.
*   All necessary middleware and controller functions are updated to utilize the new authorization model.

Please ensure your frontend is adapted to these interaction guidelines, especially regarding cookie handling and the new permissions API endpoint.

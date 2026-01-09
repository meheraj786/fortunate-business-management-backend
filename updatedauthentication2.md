# Authentication and Authorization Plan

This document provides a comprehensive overview of the authentication and authorization strategy implemented in the backend. It details how users are authenticated, how access to resources is controlled, and the key components involved in building a secure and flexible system.

## 1. Core Authentication Mechanism

The system primarily utilizes **cookie-based authentication** for managing user sessions, ensuring security and ease of use.

### 1.1 Login Process (`POST /api/v1/user/login`)

1.  **Client Request:** A user submits their credentials (email, password) to the `/api/v1/user/login` endpoint.
2.  **Server Verification:** The backend verifies these credentials against the stored user data.
3.  **Token Generation:** Upon successful authentication, a JSON Web Token (JWT) is generated. This JWT encapsulates essential user information (e.g., `_id`, `email`, `role`).
4.  **Secure Cookie Setting:** The server sets an `accessToken` cookie in the user's browser, containing the generated JWT. The cookie is configured with robust security attributes:
    *   **`httpOnly: true`**: Prevents client-side JavaScript from accessing or manipulating the cookie, significantly mitigating Cross-Site Scripting (XSS) attack vectors.
    *   **`secure: true`**: Ensures the cookie is only transmitted over encrypted HTTPS connections, protecting against Man-in-the-Middle (MITM) attacks. This is enforced even in development when `sameSite: "none"` is used for browser compatibility.
    *   **`sameSite: "none"`**: Allows the cookie to be sent with cross-site requests, which is essential if the frontend and backend are hosted on different domains or ports (e.g., frontend on `localhost:3001`, backend on `localhost:3000`).

### 1.2 Subsequent Authenticated Requests

1.  **Automatic Cookie Transmission:** For all subsequent requests to protected backend endpoints, the user's browser automatically includes the `accessToken` cookie. The frontend **does not** need to manually manage or include this token in HTTP headers.
2.  **`authenticate` Middleware (`middleware/auth.middleware.js`):** This critical middleware intercepts incoming requests. It extracts the `accessToken` from the cookie, rigorously verifies its authenticity and expiration using `jwt.verify()`. If the token is valid, the decoded user payload (containing `_id`, `email`, `role`, and other essential user data) is attached to the `req.user` object. This `req.user` object is then accessible to all subsequent middleware and controller functions, providing the context of the authenticated user.
3.  **Session Persistence:** As long as a valid and unexpired `accessToken` cookie is present, the user's session remains active across page reloads and navigations, providing a seamless "logged-in" experience.

### 1.3 Logout Process (`POST /api/v1/user/logout`)

1.  **Client Request:** A user initiates a logout action.
2.  **Server Action:** The backend's `logoutUser` function invalidates the user's session by clearing the `accessToken` cookie from the browser, effectively terminating the authenticated session.

## 2. Comprehensive Authorization Mechanism

The system implements a sophisticated **Role-Based Access Control (RBAC)** architecture enhanced with granular **Permission-Based Authorization**. This layered approach provides fine-grained control over user actions and resource access.

### 2.1 Fundamental Concepts of Permissions

*   **Roles:** Represent broad categories of users with predefined responsibilities (e.g., "SUPER_ADMIN", "MANAGER", "Accountant"). The available roles are defined as an enum within the `roleName` field of the `userSchema` in `models/user.model.js`. Roles serve as a primary level of access control.

*   **Modules:** Are logical groupings of features or resources within the application (e.g., "USER", "WAREHOUSE", "PRODUCT", "LC", "SALE", "CASH", "ACCOUNT", "TRANSACTION", "CUSTOMER", "CATEGORY", "UNIT", "TRASH"). These are centrally defined in the `MODULES` array within `utils/permissions.constants.js`. Each module represents a distinct area of functionality for which permissions can be granted.

*   **Permissions:** Represent specific, atomic actions a user can perform within a given module (e.g., `PRODUCT_CREATE`, `LC_VIEW_DETAILS`, `TRASH_DELETE_TRANSACTION`). These are exhaustively defined as individual constants within the `PERMISSIONS` object in `utils/permissions.constants.js`. This granular approach allows for highly specific control over user capabilities.

*   **User Access Array (`user.access` in `models/user.model.js`):** Every user document includes an `access` array. This array is a collection of objects, where each object specifies a `module` (e.g., "PRODUCT") and an array of `permissions` granted to the user for that specific module (e.g., `["PRODUCT_CREATE", "PRODUCT_VIEW_TABLE"]`). This structure allows for tailoring permissions on a per-module and per-user basis.

*   **Bundled Permissions (`BUNDLED_PERMISSIONS` in `utils/permissions.constants.js`):** To simplify permission management and ensure consistency, certain permissions automatically grant other related permissions. For example, granting `LC_VIEW_DETAILS` might implicitly grant `LC_EXPORT_PDF`. These relationships are defined in the `BUNDLED_PERMISSIONS` object and are automatically applied when a user's permissions are updated (e.g., by the `updateUser` function in `controllers/user.controller.js`).

### 2.2 Authorization Middlewares (`middleware/authorize.middleware.js`)

These specialized middlewares enforce authorization rules. They are typically applied in route definitions *after* the `authenticate` middleware, ensuring that only authenticated users proceed to permission checks.

1.  **`authorizeRole(requiredRole)`:**
    *   **Function:** Restricts access to a route based on the authenticated user's `roleName`.
    *   **Behavior:** Checks if `req.user.roleName` matches the `requiredRole`. Notably, users with `SUPER_ADMIN` or `ADMIN` roles are designed to bypass most specific role checks, granting them overarching access.
    *   **Example Usage in Route:** `userRoutes.post("/admin-only", authenticate, authorizeRole("ADMIN"), adminController.someFunction)`

2.  **`authorize(requiredPermission)`:**
    *   **Function:** Guards routes based on whether the authenticated user possesses a specific granular permission.
    *   **Behavior:** This middleware efficiently checks `req.user.access`. It verifies if the `requiredPermission` (e.g., `PERMISSIONS.PRODUCT_CREATE`) is explicitly present within the user's granted permissions for any module. `SUPER_ADMIN` and `ADMIN` roles inherently pass these checks.
    *   **Example Usage in Route:** `productRoutes.post("/", authenticate, authorize(PERMISSIONS.PRODUCT_CREATE), productController.createProduct)`

3.  **`authorizeWarehouseAccess(requiredPermission)`:**
    *   **Function:** Designed for operations within a specific warehouse context. It performs a two-stage authorization: first, confirming user access to the specified warehouse, then checking for a specific permission within that context.
    *   **Behavior:**
        1.  Validates if the `warehouseId` (extracted from `req.params` in the URL) is listed in `req.user.warehouse`.
        2.  If warehouse access is granted, it then performs a permission check for the `requiredPermission` (e.g., `PERMISSIONS.PRODUCT_UPDATE`) similar to the generic `authorize` middleware.
    *   **Example Usage in Route:** `warehouseRoutes.patch("/:warehouseId/products/:productId", authenticate, authorizeWarehouseAccess(PERMISSIONS.PRODUCT_UPDATE), productController.updateProductInWarehouse)`

4.  **`authorizeTrashAccess(action)`:**
    *   **Function:** Handles authorization for managing items in the trash. It dynamically constructs the necessary permission string.
    *   **Behavior:** Takes an `action` parameter (e.g., "VIEW", "RESTORE", "DELETE") and uses the `model` from `req.params` (e.g., "LC", "PRODUCT") to dynamically create a full permission string (e.g., `TRASH_VIEW_LC`). It then checks `req.user.access` for this constructed permission.
    *   **Example Usage in Route:** `trashRouter.delete("/:model/:id", authenticate, authorizeTrashAccess("DELETE"), trashController.deleteTrashPermanently)`

### 2.3 `utils/permissions.constants.js`: The Central Hub for Permissions

This file is the single source of truth for all defined permissions and modules in the system.

*   **`PERMISSIONS` Object:** Contains all unique permission strings, organized by module (e.g., `USER_CREATE`, `WAREHOUSE_VIEW`, `PRODUCT_UPDATE`). Any new granular permission must be added here.
*   **`MODULES` Array:** Lists all the application modules (e.g., "USER", "WAREHOUSE", "PRODUCT") for which permissions can be assigned. This array is crucial for frontend UIs (like a Super Admin panel) to dynamically display available modules and for backend logic like the `seed.js` script to grant broad access.
*   **`BUNDLED_PERMISSIONS` Object:** Defines logical groupings where granting a primary permission automatically implies other related permissions. This simplifies permission assignment and reduces configuration errors.

## 3. Key Components and Their Interactions

*   **`models/user.model.js`**: Defines the user data structure, including `roleName`, the `access` array (which links users to modules and their specific permissions), and the `warehouse` array (for associating users with specific warehouses).
*   **`utils/permissions.constants.js`**: As detailed above, this file is the definitive source for all `PERMISSIONS` strings, `MODULES`, and `BUNDLED_PERMISSIONS`, ensuring consistency across the entire application.
*   **`middleware/auth.middleware.js`**: Responsible solely for user authentication (verifying identity).
*   **`middleware/authorize.middleware.js`**: Houses the complete suite of authorization logic, implementing the RBAC and permission-based checks described in Section 2.2.
*   **`controllers/user.controller.js`**: Manages user-related operations, including the logic for applying `BUNDLED_PERMISSIONS` during user creation or updates.
*   **`routes/api/*.js` files**: Each module's API routes (e.g., `user.api.js`, `product.api.js`, `transaction.api.js`) meticulously apply the `authenticate` and appropriate `authorize` middlewares to protect every endpoint, defining who can access what.
*   **`routes/api/index.js`**: The central routing file that aggregates all individual module API routes under `/api/v1`. It also hosts the newly created `GET /api/v1/permissions` endpoint.

## 4. Frontend Interaction Guidelines (with an emphasis on Permissions)

### 4.1 Authenticated Requests

*   **Seamless Cookie Handling:** The frontend benefits from the `httpOnly` and `secure` cookie configuration, as the browser automatically manages and transmits the `accessToken` cookie. This means the frontend code does not need to handle JWT tokens manually in `localStorage` or `Authorization` headers for standard requests, simplifying client-side security.
*   **Robust Error Handling:** The frontend must be equipped to interpret and respond to API error codes:
    *   `401 Unauthorized`: Indicates a missing, invalid, or expired authentication token. The frontend should prompt the user to log in again.
    *   `403 Forbidden`: Signifies that the authenticated user lacks the necessary role or permission to perform the requested action. The UI should gracefully inform the user or disable/hide unauthorized features.

### 4.2 Dynamic Permission Management and Display (`GET /api/v1/permissions`)

*   **Purpose:** To empower the frontend, particularly for administrator interfaces, to dynamically display and manage permissions without being hardcoded.
*   **Usage:** The frontend should invoke the new `GET /api/v1/permissions` API endpoint. This endpoint returns an object containing:
    *   `permissions`: A comprehensive list of all individual `PERMISSIONS` strings defined in the backend.
    *   `modules`: An array of all `MODULES` defined in the backend.
*   **Benefit:** This dynamic retrieval prevents UI inconsistencies that could arise if permissions are added, modified, or removed on the backend. A SUPER_ADMIN panel, for instance, can use this data to accurately present all assignable permissions to other users, ensuring the frontend is always synchronized with the backend's authorization schema.

### 4.3 Warehouse Filtering for Non-SUPER_ADMIN Users

*   **Client-Side Filtering (Current Design):** When a user who is not a `SUPER_ADMIN` views modules like "Stock Management", the frontend should:
    1.  Call `GET /api/v1/warehouse` to retrieve the list of all active warehouses.
    2.  Filter this list on the client-side using the warehouses assigned to the authenticated user (typically found within the `req.user.warehouse` data obtained from the `/user/get-profile` endpoint).
    *   **Note:** For very large numbers of warehouses, a backend endpoint specifically designed to return user-specific warehouses would offer better performance and security.

### 4.4 Creating Products in a Specific Warehouse

*   **API Design:** When creating a new product that belongs to a specific warehouse, the frontend must use the nested URL structure: `POST /api/v1/warehouses/:warehouseId/products`.
*   **`warehouseId` Location:** The `:warehouseId` segment must be present in the URL path. The `warehouseId` should **not** be included in the request body, as it is automatically extracted from `req.params` by the backend's controller.

## 5. Current Status & Next Steps

*   The foundational cookie-based authentication and granular permission-based authorization mechanisms are fully implemented and integrated.
*   The `GET /api/v1/permissions` API endpoint is operational, enabling dynamic permission display on the frontend.
*   API data consistency for `loginUser` has been standardized to align with `getProfile`.
*   All previous runtime errors and validation issues related to authorization and permissions (e.g., 'argument handler must be a function', transaction module validation) have been resolved.
*   The `TRASH` permissions have been aligned to `TRANSACTION` module.

**Recommendation for Frontend Development:**

*   Prioritize implementing the `GET /api/v1/permissions` call in any admin panel requiring permission management.
*   Ensure that frontend logic strictly adheres to the cookie-based authentication flow (no manual JWT handling on the client-side for authentication).
*   Thoroughly implement error handling for `401 Unauthorized` and `403 Forbidden` responses across all protected routes.
*   Adapt to the current client-side filtering approach for user-specific warehouse displays until a backend alternative is provided.

This comprehensive plan ensures that the frontend and backend are perfectly synchronized regarding security and access control, facilitating robust and maintainable application development.

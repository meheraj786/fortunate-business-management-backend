class ApiResponse {
  constructor(data, message = "Success") {
    this.message = message;
    this.data = data;
  }
}

module.exports = { ApiResponse };

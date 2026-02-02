import axios from "axios";

const api = axios.create({
  baseURL: "http://localhost:5000", // ← ide jön majd az éles backend URL
  withCredentials: true, // ha van JWT, cookie vagy session
});

export default api;

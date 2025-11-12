// src/app.tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import AppointmentsList from "./pages/AppointmentsList";
import AppointmentsCalendar from "./pages/AppointmentsCalendar"; // <-- legyen exportálva
import EmployeesList from "./pages/EmployeesList";
// ... további importok

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home/>} />
        <Route path="/appointments" element={<AppointmentsList/>} />
        <Route path="/appointments/calendar" element={<AppointmentsCalendar/>} />
        <Route path="/employees" element={<EmployeesList/>} />
        {/* ide jöhetnek a többiek */}
      </Routes>
    </BrowserRouter>
  );
}

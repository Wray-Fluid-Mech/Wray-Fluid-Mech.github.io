#include <math.h>
#include <stdint.h>
#include <stddef.h>

// Helper: flux on droplet whose centre is (cx,0), with other centre at (cother,0)
static inline double flux_on_disc(double x, double y, double a, double b,
                                  double cx, double cother, double F) {
    // rho = distance to THIS droplet centre
    double dx = x - cx;
    double rho2 = dx*dx + y*y;
    if (rho2 >= a*a) return NAN; // outside the disc -> mask it

    double rho = sqrt(rho2);

    // J0 = 2/(pi*sqrt(a^2-rho^2))  (singular at the contact line)
    double denom0 = sqrt(fmax(0.0, a*a - rho2));
    double J0 = 2.0 / (M_PI * denom0);

    // distance to OTHER droplet centre
    double dxo = x - cother;
    double d = sqrt(dxo*dxo + y*y);

    // shielding factor
    double shield = (F * sqrt(fmax(0.0, b*b - a*a))) / (2.0 * M_PI * d);

    return J0 * (1.0 - shield);
}

// Fill an nx-by-ny grid (row-major) over [xmin,xmax]x[ymin,ymax].
// Output is double* out of length nx*ny; NAN outside the droplet footprints.
void fill_flux_pair(double a, double b,
                    int nx, int ny,
                    double xmin, double xmax,
                    double ymin, double ymax,
                    double *out) {

    // Integral flux F for identical pair (eq. (3.4))
    double F = 4.0 * a / (1.0 + (2.0/M_PI) * asin(a / b));

    // droplet centres at (-b/2, 0) and (+b/2, 0)
    double c1 = -0.5 * b;
    double c2 = +0.5 * b;

    double dx = (xmax - xmin) / (double)(nx - 1);
    double dy = (ymax - ymin) / (double)(ny - 1);

    for (int j = 0; j < ny; ++j) {
        double y = ymin + dy * (double)j;
        for (int i = 0; i < nx; ++i) {
            double x = xmin + dx * (double)i;

            // decide which disc we’re in
            double r1 = (x - c1)*(x - c1) + y*y;
            double r2 = (x - c2)*(x - c2) + y*y;

            double val = NAN;
            if (r1 < a*a) {
                val = flux_on_disc(x, y, a, b, c1, c2, F);
            } else if (r2 < a*a) {
                val = flux_on_disc(x, y, a, b, c2, c1, F);
            }
            out[j*nx + i] = val;
        }
    }
}

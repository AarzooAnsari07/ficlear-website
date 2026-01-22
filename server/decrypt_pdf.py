#!/usr/bin/env python3
"""
PDF decryption script using pikepdf - handles AES-256 encrypted PDFs
Usage: python decrypt_pdf.py <input_pdf_path> <password> <output_pdf_path>
"""

import sys
import os

try:
    import pikepdf
except ImportError:
    print("ERROR: pikepdf not installed. Install with: pip install pikepdf")
    sys.exit(1)

def decrypt_pdf(input_path, password, output_path):
    """Decrypt a PDF file using pikepdf"""
    try:
        with pikepdf.open(input_path, password=password) as pdf:
            pdf.save(output_path)
        print("SUCCESS")
        return True
    except pikepdf.PasswordError:
        print("ERROR: Incorrect password")
        return False
    except Exception as e:
        print(f"ERROR: {str(e)}")
        return False

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python decrypt_pdf.py <input.pdf> <password> <output.pdf>")
        sys.exit(1)
    
    input_path = sys.argv[1]
    password = sys.argv[2]
    output_path = sys.argv[3]
    
    if not os.path.exists(input_path):
        print(f"ERROR: Input file not found: {input_path}")
        sys.exit(1)
    
    success = decrypt_pdf(input_path, password, output_path)
    sys.exit(0 if success else 1)
